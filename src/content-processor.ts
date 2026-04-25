import type { Summarizer } from "./types.js";
import type { ContentFilterRule, TextBlock } from "./content-filter.js";
import { applyContentFilters } from "./content-filter.js";
import { ContentStorage } from "./content-storage.js";

const PREVIEW_SIZE = 2000;
const PERSISTED_MARKER = "<persisted-output>";

type InternalBlock = TextBlock & { raw?: unknown };

export type ContentProcessorConfig = {
  largeTextThreshold: number;
  contentFilters: ContentFilterRule[];
  llmEnabled: boolean;
};

export type ProcessedContent = {
  contextText: string;
  dropMessage: boolean;
};

export class ContentProcessor {
  constructor(
    private readonly config: ContentProcessorConfig,
    private readonly storage: ContentStorage,
    private readonly summarizer?: Summarizer,
  ) {}

  /**
   * Ingest-only: persist large content to disk and return persisted-output format.
   * Returns null if content doesn't need persistence (below threshold or already persisted).
   */
  async persistLargeContent(
    content: unknown,
    sessionId: string,
  ): Promise<string | null> {
    const text = this.extractTextContent(content);
    if (text.length < this.config.largeTextThreshold) return null;
    if (text.startsWith(PERSISTED_MARKER)) return null;
    return this.processLargeText(text, sessionId);
  }

  /**
   * AfterTurn: full processing — normalize, filter, persist media/large text.
   */
  async processContent(
    content: unknown,
    sessionId: string,
  ): Promise<ProcessedContent> {
    const blocks = this.normalizeContent(content);

    if (this.config.contentFilters.length > 0) {
      const filterResult = applyContentFilters(blocks, this.config.contentFilters);
      if (filterResult.dropMessage) {
        return { contextText: "", dropMessage: true };
      }
      if (filterResult.filteredBlocks) {
        const filtered = filterResult.filteredBlocks;
        blocks.length = 0;
        for (const fb of filtered) {
          blocks.push(fb as InternalBlock);
        }
      }
    }

    if (blocks.length === 0) {
      return { contextText: "", dropMessage: false };
    }

    const parts: string[] = [];
    for (const block of blocks) {
      const text = await this.processBlock(block, sessionId);
      if (text) parts.push(text);
    }

    return { contextText: parts.join("\n\n"), dropMessage: false };
  }

  // ── Internal ────────────────────────────────────────────────────

  private extractTextContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part: unknown) => {
          if (typeof part === "string") return part;
          if (part && typeof part === "object") {
            const p = part as { text?: string; content?: string };
            if (typeof p.text === "string") return p.text;
            if (typeof p.content === "string") return p.content;
          }
          return "";
        })
        .join(" ")
        .trim();
    }
    if (content && typeof content === "object") {
      const c = content as { text?: string; content?: string };
      return c.text ?? c.content ?? "";
    }
    return "";
  }

  private normalizeContent(content: unknown): InternalBlock[] {
    if (content == null) return [];
    if (typeof content === "string") {
      return [{ type: "text", text: content }];
    }
    if (Array.isArray(content)) {
      return content.map((block) => this.toInternalBlock(block));
    }
    return [this.toInternalBlock(content)];
  }

  private toInternalBlock(block: unknown): InternalBlock {
    if (typeof block === "string") {
      return { type: "text", text: block };
    }
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      const type = typeof b.type === "string" ? b.type : "unknown";

      if (type === "image" || type === "audio" || type === "file") {
        return { type, text: "", raw: block };
      }

      const text =
        typeof b.text === "string" ? b.text :
        typeof b.content === "string" ? b.content :
        "";

      return { type, text };
    }
    return { type: "unknown", text: "" };
  }

  private async processBlock(block: InternalBlock, sessionId: string): Promise<string> {
    const { type, text } = block;

    if (type === "image" || type === "audio" || type === "file") {
      return this.processMediaBlock(block, sessionId);
    }

    // Skip already-persisted content (from ingest)
    if (text.startsWith(PERSISTED_MARKER)) {
      return text;
    }

    if (text.length < this.config.largeTextThreshold) {
      return text;
    }

    return this.processLargeText(text, sessionId);
  }

  private async processLargeText(
    text: string,
    sessionId: string,
  ): Promise<string> {
    const storagePath = await this.storage.storeText(sessionId, text);

    const sizeStr = text.length >= 1024
      ? `${(text.length / 1024).toFixed(1)}KB`
      : `${text.length} chars`;
    const lines = text.split("\n").length;

    const sizeInfo = `- **Size**: ${sizeStr}, ${lines} lines\n- **File**: ${storagePath}`;

    const parts: string[] = [
      `<persisted-output>`,
      sizeInfo,
      `</persisted-output>`,
    ];

    if (this.config.llmEnabled && this.summarizer) {
      try {
        const summary = await this.summarizer.rawGenerate(
          [
            "Analyze the content and output a structured preview. /no_think",
            "",
            "Output ONLY these lines (markdown):",
            "- **Type**: content type (log / source-code / data-table / config / markup / text / json / csv / other)",
            "- **Content**: 1-2 sentence description of what this content contains",
            "- **Structure**: key sections or patterns (e.g. headings, columns, stack frames)",
          ].join("\n"),
          text.slice(0, 4000),
          300,
        );
        if (summary) {
          parts.splice(1, 0, summary);
        }
      } catch {
        // best-effort
      }
    }

    // Preview: first 1000 + last 1000
    parts.splice(parts.length - 1, 0,
      "",
      "--- Preview (first 1000 chars) ---",
      text.slice(0, 1000),
      "",
      "--- Preview (last 1000 chars) ---",
      text.slice(-1000),
    );

    const tail = text.slice(-1000);
    parts.splice(parts.length - 1, 0, "", `--- Tail (last 1000 chars) ---`, tail);

    return parts.join("\n");
  }

  private async processMediaBlock(
    block: InternalBlock,
    sessionId: string,
  ): Promise<string> {
    const raw = (block.raw ?? block) as Record<string, unknown>;
    const mediaType = this.extractMediaType(raw);
    const data = this.extractMediaData(raw);
    const name = typeof raw.name === "string" ? raw.name : undefined;
    const prefix = block.type === "image" ? "img" : block.type === "audio" ? "audio" : "file";

    if (!data || data.length === 0) {
      return `[${block.type}: no data${name ? `, name=${name}` : ""}]`;
    }

    const storagePath = await this.storage.storeMedia(
      sessionId,
      data,
      mediaType,
      prefix,
    );

    const sizeStr = data.length >= 1024
      ? `${(data.length / 1024).toFixed(1)}KB`
      : `${data.length} bytes`;

    const parts = [
      `${block.type} stored: ${storagePath}`,
      mediaType ?? "unknown type",
      sizeStr,
    ];
    if (name) parts.push(`name=${name}`);

    return `[${parts.join(" | ")}]`;
  }

  private extractMediaType(raw: Record<string, unknown>): string | undefined {
    if (typeof raw.mediaType === "string") return raw.mediaType;
    if (typeof raw.mime_type === "string") return raw.mime_type;
    if (typeof raw.mimeType === "string") return raw.mimeType;
    const source = raw.source;
    if (source && typeof source === "object") {
      const s = source as Record<string, unknown>;
      if (typeof s.media_type === "string") return s.media_type;
      if (typeof s.mediaType === "string") return s.mediaType;
    }
    return undefined;
  }

  private extractMediaData(raw: Record<string, unknown>): Buffer | null {
    if (raw.data instanceof Buffer) return raw.data;
    if (typeof raw.data === "string") {
      return this.decodeBase64Data(raw.data);
    }
    const source = raw.source;
    if (source && typeof source === "object") {
      const s = source as Record<string, unknown>;
      if (s.data instanceof Buffer) return s.data;
      if (typeof s.data === "string") {
        return this.decodeBase64Data(s.data);
      }
      if (typeof s.url === "string") {
        return Buffer.from(s.url);
      }
    }
    return null;
  }

  private decodeBase64Data(data: string): Buffer {
    const base64Match = data.match(/^data:[^;]+;base64,(.+)$/s);
    const raw = base64Match ? base64Match[1] : data;
    return Buffer.from(raw, "base64");
  }
}
