import type { Summarizer } from "./types.js";

// ── Prompt constants ──────────────────────────────────────────────

const SUMMARY_SYSTEM_PROMPT =
  "You are a context-compaction summarization engine. Follow user instructions exactly and return plain text summary content only. /no_think";

// ── Shared helpers ────────────────────────────────────────────────

export function buildSummaryPrompt(
  text: string,
  targetTokens: number,
  previousSummary?: string,
  customInstructions?: string,
): string {
  const parts: string[] = [
    "You summarize a SEGMENT of a conversation for future model turns.",
    "Treat this as incremental memory compaction input, not a full-conversation summary.",
    "",
    "Normal summary policy:",
    "- Preserve key decisions, rationale, constraints, and active tasks.",
    "- Keep essential technical details needed to continue work safely.",
    "- Track file operations (created, modified, deleted) with file paths and current status.",
    '- If no file operations appear, include exactly: "Files: none".',
    "- Remove obvious repetition and conversational filler.",
  ];

  if (customInstructions?.trim()) {
    parts.push("", `Operator instructions:\n${customInstructions.trim()}`);
  } else {
    parts.push("", "Operator instructions: (none)");
  }

  parts.push(
    "",
    "Output requirements:",
    "- Plain text only.",
    "- No preamble, headings, or markdown formatting.",
    "- Keep it concise while preserving required details.",
    `- Target length: about ${targetTokens} tokens or less.`,
  );

  const prev = previousSummary?.trim();
  if (prev) {
    parts.push("", `<previous_context>\n${prev}\n</previous_context>`);
  }

  parts.push("", `<conversation_segment>\n${text}\n</conversation_segment>`);

  return parts.join("\n");
}

export function extractContentText(content: unknown): string {
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
  return "";
}

// ── RuntimeSummarizer ─────────────────────────────────────────────
// Wraps OpenClaw's runtime complete function (received via plugin api).

export type CompleteFn = (params: {
  provider?: string;
  model?: string;
  apiKey?: string;
  messages: Array<{ role: string; content: unknown }>;
  system?: string;
  maxTokens: number;
}) => Promise<{ content: unknown[]; error?: { message?: string } }>;

export class RuntimeSummarizer implements Summarizer {
  constructor(
    private readonly complete: CompleteFn,
    private readonly model: string,
    private readonly customInstructions?: string,
  ) {}

  async summarize(text: string, targetTokens: number): Promise<string> {
    const prompt = buildSummaryPrompt(text, targetTokens, undefined, this.customInstructions);
    const result = await this.complete({
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      system: SUMMARY_SYSTEM_PROMPT,
      maxTokens: targetTokens,
    });
    if (result.error?.message) {
      throw new Error(`Runtime complete error: ${result.error.message}`);
    }
    return extractContentText(result.content);
  }
}

// ── HttpSummarizer ────────────────────────────────────────────────
// Calls any OpenAI-compatible API directly (Ollama, LM Studio, etc.).

export class HttpSummarizer implements Summarizer {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly customInstructions?: string;

  constructor(opts: {
    baseUrl: string;
    model: string;
    apiKey?: string;
    timeoutMs?: number;
    customInstructions?: string;
  }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.customInstructions = opts.customInstructions;
  }

  async summarize(text: string, targetTokens: number): Promise<string> {
    const prompt = buildSummaryPrompt(text, targetTokens, undefined, this.customInstructions);

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: SUMMARY_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        max_tokens: targetTokens * 2,
        stream: false,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${body}`);
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning?: string } }>;
    };
    const msg = json.choices?.[0]?.message;
    let content = msg?.content?.trim();
    // Ollama Qwen3: thinking tokens go to reasoning field, content may be empty
    if (!content && msg?.reasoning) {
      content = msg.reasoning.trim();
    }
    if (!content) {
      throw new Error("Empty response from summarizer");
    }
    return content;
  }
}

export { SUMMARY_SYSTEM_PROMPT };
