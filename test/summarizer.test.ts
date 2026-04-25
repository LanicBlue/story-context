import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  HttpSummarizer,
  RuntimeSummarizer,
  extractContentText,
} from "../src/summarizer.js";

describe("extractContentText", () => {
  it("returns string directly", () => {
    expect(extractContentText("hello")).toBe("hello");
  });

  it("joins array of content blocks", () => {
    const content = [
      { type: "text", text: "hello " },
      { type: "text", text: "world" },
    ];
    expect(extractContentText(content)).toBe("hello  world");
  });

  it("handles mixed array", () => {
    const content = ["plain text", { type: "text", content: " block" }];
    expect(extractContentText(content)).toBe("plain text  block");
  });

  it("returns empty string for nullish", () => {
    expect(extractContentText(undefined)).toBe("");
    expect(extractContentText(null as unknown)).toBe("");
  });
});

describe("HttpSummarizer", () => {
  let summarizer: HttpSummarizer;

  beforeEach(() => {
    summarizer = new HttpSummarizer({
      baseUrl: "http://localhost:11434/v1",
      model: "qwen2.5",
      timeoutMs: 5000,
    });
    vi.restoreAllMocks();
  });

  it("calls OpenAI-compatible API and returns content", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "Summary of the conversation" } }],
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await summarizer.rawGenerate("system prompt", "user prompt", 600);
    expect(result).toBe("Summary of the conversation");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    expect(opts.method).toBe("POST");

    const body = JSON.parse(opts.body);
    expect(body.model).toBe("qwen2.5");
    expect(body.max_tokens).toBe(600);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
  });

  it("sends Authorization header when apiKey is set", async () => {
    const authSummarizer = new HttpSummarizer({
      baseUrl: "http://api.example.com/v1",
      model: "gpt-4",
      apiKey: "sk-test-key",
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "summary" } }],
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await authSummarizer.rawGenerate("sys", "user", 300);
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["Authorization"]).toBe("Bearer sk-test-key");
  });

  it("throws on HTTP error", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve("rate limited"),
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(summarizer.rawGenerate("sys", "text", 600)).rejects.toThrow("HTTP 429");
  });

  it("throws on empty response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: "" } }] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(summarizer.rawGenerate("sys", "text", 600)).rejects.toThrow("Empty response");
  });

  it("strips trailing slashes from baseUrl", async () => {
    const s = new HttpSummarizer({
      baseUrl: "http://localhost:11434/v1///",
      model: "qwen2.5",
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "ok" } }],
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await s.rawGenerate("sys", "text", 600);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
  });
});

describe("RuntimeSummarizer", () => {
  it("calls complete function with correct params", async () => {
    const mockComplete = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "runtime summary" }],
    });

    const summarizer = new RuntimeSummarizer(mockComplete, "claude-sonnet-4");
    const result = await summarizer.rawGenerate("system prompt", "user prompt", 400);

    expect(result).toBe("runtime summary");
    expect(mockComplete).toHaveBeenCalledTimes(1);

    const [params] = mockComplete.mock.calls[0];
    expect(params.model).toBe("claude-sonnet-4");
    expect(params.maxTokens).toBe(400);
    expect(params.system).toBe("system prompt");
    expect(params.messages[0].role).toBe("user");
  });

  it("throws on complete error", async () => {
    const mockComplete = vi.fn().mockResolvedValue({
      content: [],
      error: { message: "model unavailable" },
    });

    const summarizer = new RuntimeSummarizer(mockComplete, "test-model");
    await expect(summarizer.rawGenerate("sys", "text", 400)).rejects.toThrow("model unavailable");
  });
});
