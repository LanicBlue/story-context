import type { Summarizer } from "./types.js";
import type { ContentFilterRule, TextBlock } from "./content-filter.js";
import { applyContentFilters } from "./content-filter.js";
import { ContentStorage } from "./content-storage.js";

const PREVIEW_SIZE = 2000;

type InternalBlock = TextBlock & { raw?: unknown };

export type ContentProcessorConfig = {
  largeTextThreshold: number;
  contentFilters: ContentFilterRule[];
  summaryEnabled: boolean;
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

  async processContent(
    content: unknown,
    sessionId: string,
  ): Promise<ProcessedContent> {
    // Normalize content into blocks
    const blocks = this.normalizeContent(content);

    // Apply content filters
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

    // Process each block
    const parts: string[] = [];
    for (const block of blocks) {
      const text = await this.processBlock(block, sessionId);
      if (text) parts.push(text);
    }

    return { contextText: parts.join("\n\n"), dropMessage: false };
  }

  async cleanupSession(sessionId: string): Promise<void> {
    await this.storage.cleanupSession(sessionId);
  }

  // ── Internal ────────────────────────────────────────────────────

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

      // Media block types — preserve raw for later extraction
      if (type === "image" || type === "audio" || type === "file") {
        return { type, text: "", raw: block };
      }

      // Text-like blocks
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

    // Media blocks — store to disk, return metadata
    if (type === "image" || type === "audio" || type === "file") {
      return this.processMediaBlock(block, sessionId);
    }

    // Short text — passthrough
    if (text.length < this.config.largeTextThreshold) {
      return text;
    }

    // Large text — store to disk, generate outline
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

    const parts: string[] = [
      `<persisted-output>`,
      `Output too large (${sizeStr}, ${lines} lines). Full output saved to: ${storagePath}`,
      ``,
      `Preview (first ${PREVIEW_SIZE} chars):`,
      text.slice(0, PREVIEW_SIZE),
      `</persisted-output>`,
    ];

    // LLM summary — concise abstract of the full content
    if (this.config.summaryEnabled && this.summarizer) {
      try {
        const summary = await this.summarizer.summarize(text, 300);
        if (summary) {
          parts.splice(1, 0, ``, `--- AI Summary ---`, summary);
        }
      } catch {
        // best-effort
      }
    }

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
      // No actual data to store — just metadata
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
    // Check common locations for media type
    if (typeof raw.mediaType === "string") return raw.mediaType;
    if (typeof raw.mime_type === "string") return raw.mime_type;
    if (typeof raw.mimeType === "string") return raw.mimeType;
    // Check source block
    const source = raw.source;
    if (source && typeof source === "object") {
      const s = source as Record<string, unknown>;
      if (typeof s.media_type === "string") return s.media_type;
      if (typeof s.mediaType === "string") return s.mediaType;
    }
    return undefined;
  }

  private extractMediaData(raw: Record<string, unknown>): Buffer | null {
    // Direct data field
    if (raw.data instanceof Buffer) return raw.data;
    if (typeof raw.data === "string") {
      return this.decodeBase64Data(raw.data);
    }

    // Source block (Anthropic/OpenAI style)
    const source = raw.source;
    if (source && typeof source === "object") {
      const s = source as Record<string, unknown>;
      if (s.data instanceof Buffer) return s.data;
      if (typeof s.data === "string") {
        return this.decodeBase64Data(s.data);
      }
      // URL source — store URL reference
      if (typeof s.url === "string") {
        return Buffer.from(s.url);
      }
    }

    return null;
  }

  private decodeBase64Data(data: string): Buffer {
    // Strip data URI prefix if present: data:image/png;base64,...
    const base64Match = data.match(/^data:[^;]+;base64,(.+)$/s);
    const raw = base64Match ? base64Match[1] : data;
    return Buffer.from(raw, "base64");
  }
}
