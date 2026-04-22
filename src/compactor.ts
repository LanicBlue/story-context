import type { Summarizer, CompressedWindow } from "./types.js";
import { ContentStorage } from "./content-storage.js";
import { EventStorage } from "./event-storage.js";

const COMPACT_SYSTEM_PROMPT =
  "You are a conversation compression engine. Categorize conversation content by event elements, output pure Markdown. Only record valuable information; omit conversational filler and repetition. /no_think";

const COMPACT_USER_TEMPLATE = `The following are consecutive conversation segments. Compress the [Core Content] section in the middle.

[Preceding Context]
{preOverlap}

[Core Content — Compress]
{core}

[Following Context]
{postOverlap}

Output Markdown with these sections:
## Task Intent
What the user asked to do
## Key Decisions
What decisions were made and why
## Operations
| Operation | Target | Result |
## File Changes
Which files were involved and what changes were made
## Issues and Findings
Problems encountered and discoveries
## Conclusion
Final results and status`;

export type WindowConfig = {
  coreChars: number;
  overlapChars: number;
};

export type CompressionWindow = {
  coreMessages: unknown[];
  preOverlap: string;
  postOverlap: string;
  coreStartIdx: number;
  coreEndIdx: number;
  coreTotalChars: number;
};

export class Compactor {
  private readonly eventStorage: EventStorage;

  constructor(
    private readonly storage: ContentStorage,
    private readonly summarizer?: Summarizer,
  ) {
    this.eventStorage = new EventStorage(storage);
  }

  /** Build a compression window from the oldest active messages. */
  buildWindow(
    messages: unknown[],
    activeStart: number,
    config: WindowConfig,
  ): CompressionWindow {
    const coreMessages: unknown[] = [];
    let coreChars = 0;
    let coreEndIdx = activeStart;

    // Accumulate core messages up to ~coreChars (respecting message boundaries)
    for (let i = activeStart; i < messages.length; i++) {
      const text = extractText(messages[i]);
      if (coreMessages.length > 0 && coreChars + text.length > config.coreChars * 1.15) {
        break; // Would exceed 15% over budget — stop
      }
      coreMessages.push(messages[i]);
      coreChars += text.length;
      coreEndIdx = i + 1;
      if (coreChars >= config.coreChars) break;
    }

    // Pre-overlap: one message before core (if it exists)
    let preOverlap = "";
    if (activeStart > 0) {
      const preMsg = messages[activeStart - 1];
      const preText = extractText(preMsg);
      preOverlap = preText.length > config.overlapChars
        ? "..." + preText.slice(-(config.overlapChars))
        : preText;
    }

    // Post-overlap: one message after core (if it exists)
    let postOverlap = "";
    if (coreEndIdx < messages.length) {
      const postMsg = messages[coreEndIdx];
      const postText = extractText(postMsg);
      postOverlap = postText.length > config.overlapChars
        ? postText.slice(0, config.overlapChars) + "..."
        : postText;
    }

    return {
      coreMessages,
      preOverlap,
      postOverlap,
      coreStartIdx: activeStart,
      coreEndIdx,
      coreTotalChars: coreChars,
    };
  }

  /** Compress using LLM. */
  async compressWithLLM(
    preOverlap: string,
    core: string,
    postOverlap: string,
    targetTokens: number,
  ): Promise<string> {
    if (!this.summarizer) throw new Error("No summarizer available");

    const prompt = COMPACT_USER_TEMPLATE
      .replace("{preOverlap}", preOverlap || "(none)")
      .replace("{core}", core)
      .replace("{postOverlap}", postOverlap || "(none)");

    return this.summarizer.summarize(prompt, targetTokens);
  }

  /** Build structural summary without LLM. */
  buildStructuralSummary(coreMessages: unknown[]): string {
    const tasks: string[] = [];
    const decisions: string[] = [];
    const operations: Array<[string, string, string]> = [];
    const fileChanges: string[] = [];
    const findings: string[] = [];
    const conclusions: string[] = [];

    for (const msg of coreMessages) {
      const role = extractRole(msg);
      const text = extractText(msg);
      if (!text) continue;

      if (role === "user") {
        tasks.push(text.replace(/\n/g, " ").trim());
      } else if (role === "assistant") {
        // Extract key statements (non-trivial sentences)
        const sentences = text
          .split(/[.!?。！？\n]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 10 && !isFiller(s));
        for (const s of sentences.slice(0, 3)) {
          if (s.includes("决定") || s.includes("选择") || s.includes("使用") ||
              s.includes("decided") || s.includes("chose") || s.includes("selected")) {
            decisions.push(s);
          } else if (s.includes("完成") || s.includes("成功") || s.includes("失败") || s.includes("通过") ||
                     s.includes("completed") || s.includes("success") || s.includes("failed") || s.includes("passed")) {
            conclusions.push(s);
          } else {
            findings.push(s);
          }
        }
      } else if (role === "toolResult") {
        const toolName = extractToolName(msg);
        const filePath = extractToolArg(msg, "path");
        const resultSummary = extractResultSummary(text);
        operations.push([toolName || "unknown", filePath || "-", resultSummary]);

        if (filePath && (toolName === "write_file" || toolName === "patch_file")) {
          fileChanges.push(`${filePath}: ${resultSummary}`);
        }
      }
    }

    // Build markdown
    const parts: string[] = [];
    parts.push(`# Compressed Summary — ${new Date().toISOString()}`);

    if (tasks.length > 0) {
      parts.push("", "## Task Intent");
      for (const t of tasks) parts.push(`- ${t}`);
    }
    if (decisions.length > 0) {
      parts.push("", "## Key Decisions");
      for (const d of decisions) parts.push(`- ${d}`);
    }
    if (operations.length > 0) {
      parts.push("", "## Operations");
      parts.push("| Operation | Target | Result |");
      parts.push("|------|------|------|");
      for (const [op, target, result] of operations) {
        parts.push(`| ${op} | ${target} | ${result} |`);
      }
    }
    if (fileChanges.length > 0) {
      parts.push("", "## File Changes");
      for (const fc of fileChanges) parts.push(`- ${fc}`);
    }
    if (findings.length > 0) {
      parts.push("", "## Issues and Findings");
      for (const f of findings) parts.push(`- ${f}`);
    }
    if (conclusions.length > 0) {
      parts.push("", "## Conclusion");
      for (const c of conclusions) parts.push(`- ${c}`);
    }

    return parts.join("\n");
  }

  /** Save summary to disk with date-based naming and return CompressedWindow metadata. */
  async saveSummary(
    sessionId: string,
    markdown: string,
    messageRange: [number, number],
    originalChars: number,
  ): Promise<CompressedWindow> {
    const relPath = await this.eventStorage.nextSummaryName(sessionId);
    await this.eventStorage.writeSummary(sessionId, relPath, markdown);

    return {
      storagePath: relPath,
      messageRange,
      originalChars,
      compressedChars: markdown.length,
      timestamp: Date.now(),
    };
  }

  /** Get the EventStorage instance for use by engine. */
  getEventStorage(): EventStorage {
    return this.eventStorage;
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function extractRole(msg: unknown): string {
  return (msg as { role?: string }).role ?? "unknown";
}

function extractText(msg: unknown): string {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as { type?: string; text?: string; content?: string };
          if (typeof p.text === "string") return p.text;
          if (p.type === "text" && typeof p.content === "string") return p.content;
        }
        return "";
      })
      .join(" ")
      .trim();
  }
  return "";
}

function extractToolName(msg: unknown): string {
  return (msg as { toolName?: string }).toolName ?? "";
}

function extractToolArg(msg: unknown, key: string): string {
  const args = (msg as { args?: Record<string, unknown> }).args;
  if (args && typeof args === "object") {
    const val = args[key];
    return typeof val === "string" ? val : "";
  }
  return "";
}

/** Extract a short result summary from tool output text. */
function extractResultSummary(text: string): string {
  // If it's an outline, take just the first data line
  if (text.startsWith("[Stored:")) {
    const bracketEnd = text.indexOf("]");
    return bracketEnd !== -1 ? text.slice(0, bracketEnd + 1) : text.slice(0, 80);
  }
  // If it's a media ref, keep it
  if (text.startsWith("[image") || text.startsWith("[file") || text.startsWith("[audio")) {
    return text.slice(0, 100);
  }
  // Truncate plain text
  const clean = text.replace(/\n/g, " ").trim();
  return clean.length > 80 ? clean.slice(0, 77) + "..." : clean;
}

const FILLER_PATTERNS = [
  /^(ok|okay|sure|yes|好的|明白|了解|let me|i'll|i will|i can|sure,?)/i,
  /^(let me |i'll |i will |let's |first,? |now,? )/i,
];

function isFiller(text: string): boolean {
  return FILLER_PATTERNS.some((p) => p.test(text));
}

export { extractText, extractRole, extractToolName, extractToolArg, COMPACT_SYSTEM_PROMPT };
