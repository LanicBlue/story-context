import type { Summarizer } from "./types.js";

// ── Shared helpers ────────────────────────────────────────────────

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
  ) {}

  async rawGenerate(systemPrompt: string, userPrompt: string, maxTokens: number): Promise<string> {
    const result = await this.complete({
      model: this.model,
      messages: [{ role: "user", content: userPrompt }],
      system: systemPrompt,
      maxTokens,
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

  constructor(opts: {
    baseUrl: string;
    model: string;
    apiKey?: string;
    timeoutMs?: number;
  }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async rawGenerate(systemPrompt: string, userPrompt: string, maxTokens: number): Promise<string> {
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
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: maxTokens,
        stream: false,
        ...(this.model.includes("qwen3") ? { enable_thinking: false } : {}),
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
    if (!content && msg?.reasoning) {
      content = msg.reasoning.trim();
    }
    if (!content) {
      throw new Error("Empty response from summarizer");
    }
    return content;
  }
}
