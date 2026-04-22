import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SmartContextEngine } from "../src/engine.js";
import { HttpSummarizer } from "../src/summarizer.js";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const TEST_OUTPUT_DIR = join(DATA_DIR, "session-test-output");

const OLLAMA_BASE_URL = "http://localhost:11434/v1";
const OLLAMA_MODEL = "qwen2.5:3b";
const TIMEOUT_MS = 180_000;

function createSummarizer(): HttpSummarizer {
  return new HttpSummarizer({
    baseUrl: OLLAMA_BASE_URL,
    model: OLLAMA_MODEL,
    timeoutMs: TIMEOUT_MS,
  });
}

// ── Session file loader ─────────────────────────────────────────────

type SessionEntry = {
  type: string;
  message?: {
    role: string;
    content: unknown;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    timestamp?: number;
    // assistant-specific
    api?: string;
    provider?: string;
    model?: string;
    usage?: unknown;
    stopReason?: string;
  };
};

function loadSessionFile(filename: string): Array<Record<string, unknown>> {
  const raw = readFileSync(join(DATA_DIR, filename), "utf-8");
  const lines = raw.split("\n").filter(Boolean);

  const messages: Array<Record<string, unknown>> = [];

  for (const line of lines) {
    const entry: SessionEntry = JSON.parse(line);
    if (entry.type !== "message" || !entry.message) continue;

    const msg = entry.message;
    const role = msg.role;

    if (role === "user") {
      // Extract text from content blocks
      const text = extractTextFromBlocks(msg.content);
      messages.push({
        role: "user",
        content: text,
        timestamp: msg.timestamp ?? Date.now(),
      });
    } else if (role === "assistant") {
      // Separate text and tool calls into distinct messages
      const blocks = normalizeContent(msg.content);
      const textParts: string[] = [];
      const toolCalls: Array<Record<string, unknown>> = [];

      for (const block of blocks) {
        if (block.type === "toolCall") {
          toolCalls.push({
            type: "toolCall",
            id: block.id,
            name: block.name,
            arguments: block.arguments,
          });
        } else if (block.text) {
          textParts.push(block.text);
        }
      }

      // Push text part as assistant message
      const textContent = textParts.join("\n").trim();
      if (textContent) {
        messages.push({
          role: "assistant",
          content: textContent,
          timestamp: msg.timestamp ?? Date.now(),
        });
      }

      // Push tool calls as separate entries
      for (const tc of toolCalls) {
        messages.push({
          role: "assistant",
          content: "", // tool call has no text content
          toolCalls: [tc],
          timestamp: msg.timestamp ?? Date.now(),
        });
      }
    } else if (role === "toolResult") {
      const text = extractTextFromBlocks(msg.content);
      messages.push({
        role: "toolResult",
        content: text,
        toolName: msg.toolName ?? "unknown",
        toolCallId: msg.toolCallId,
        isError: msg.isError ?? false,
        args: {},
        timestamp: msg.timestamp ?? Date.now(),
      });
    }
  }

  return messages;
}

function extractTextFromBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: unknown) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object") {
          const b = block as { type?: string; text?: string; content?: string; thinking?: string };
          if (b.type === "thinking") return "";
          if (typeof b.text === "string") return b.text;
          if (typeof b.content === "string") return b.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

type ContentBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
};

function normalizeContent(content: unknown): ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) {
    return content.map((block: unknown) => {
      if (typeof block === "string") return { type: "text", text: block };
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        return {
          type: typeof b.type === "string" ? b.type : "unknown",
          text: typeof b.text === "string" ? b.text : undefined,
          id: typeof b.id === "string" ? b.id : undefined,
          name: typeof b.name === "string" ? b.name : undefined,
          arguments: b.arguments && typeof b.arguments === "object"
            ? b.arguments as Record<string, unknown>
            : undefined,
        };
      }
      return { type: "unknown" };
    });
  }
  return [];
}

// ── Helpers ──────────────────────────────────────────────────────────

function cleanTestDir(name: string): string {
  const dir = join(TEST_OUTPUT_DIR, name);
  if (existsSync(dir)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ }
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function runPipeline(
  messages: Array<Record<string, unknown>>,
  storageDir: string,
  batchSize: number,
  onProgress?: (info: { batch: number; total: number; compactCount: number }) => void,
): Promise<{
  state: ReturnType<SmartContextEngine["_getState"]>;
  assembleResult: Awaited<ReturnType<SmartContextEngine["assemble"]>>;
}> {
  const summarizer = createSummarizer();
  const engine = new SmartContextEngine({
    maxHistoryTokens: 16_000,
    compactCoreTokens: 6_000,
    compactOverlapTokens: 1_000,
    largeTextThreshold: 4000,
    summaryEnabled: true,
    sessionFilter: "all",
    storageDir,
    contentFilters: [
      { match: "contains", pattern: "## User's conversation history", granularity: "message" },
      { match: "contains", pattern: "## Memory system", granularity: "message" },
      { match: "regex", pattern: "^NO_REPLY\\s*$", granularity: "message" },
      { match: "regex", pattern: "^HEARTBEAT_OK\\s*$", granularity: "line" },
      { match: "regex", pattern: "^HEARTBEAT_CHECK\\s*$", granularity: "line" },
      { match: "regex", pattern: "^<<<EXTERNAL_UNTRUSTED_CONTENT.*>>>$", granularity: "line" },
      { match: "regex", pattern: "^<<<END_EXTERNAL_UNTRUSTED_CONTENT.*>>>$", granularity: "line" },
    ],
  }, summarizer);

  const sessionId = "session";
  let compactCount = 0;
  const totalBatches = Math.ceil(messages.length / batchSize);

  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize);
    for (const msg of batch) {
      await engine.ingest({ sessionId, message: msg });
    }

    // afterTurn: process messages from this batch
    await engine.afterTurn({ sessionId, sessionFile: "" });

    const cr = await engine.compact({ sessionId, sessionFile: "" });
    if (cr.compacted) compactCount++;

    const batchNum = Math.floor(i / batchSize) + 1;
    if (batchNum % 5 === 0 || batchNum === totalBatches) {
      const state = engine._getState(sessionId);
      console.log(
        `[Batch ${batchNum}/${totalBatches}] compactions=${compactCount}, ` +
        `windows=${state?.compressedWindows.length ?? 0}, ` +
        `events=${state?.activeEvents.length ?? 0}`,
      );
    }

    if (onProgress) onProgress({ batch: batchNum, total: totalBatches, compactCount });
  }

  const state = engine._getState(sessionId)!;
  const assembleResult = await engine.assemble({ sessionId, messages: [] });

  console.log(`\n=== Final State ===`);
  console.log(`Messages: ${state.messages.length}, Windows: ${state.compressedWindows.length}, Events: ${state.activeEvents.length}`);
  console.log(`Assemble: ${assembleResult.messages.length} msgs, ${assembleResult.estimatedTokens} tokens`);

  return { state, assembleResult };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("Real session file tests", () => {
  it(
    "session 06bc5eef: smoke test (200 messages)",
    async () => {
      const filename = "06bc5eef-dc76-45d8-8ad7-af34816fe5f7.jsonl.reset.2026-04-06T20-12-53.300Z";
      const allMessages = loadSessionFile(filename);
      const messages = allMessages.slice(0, 200);
      console.log(`\n[Session 06bc5eef smoke] Loaded ${messages.length}/${allMessages.length} messages`);

      const roles: Record<string, number> = {};
      for (const m of messages) {
        const r = (m as { role: string }).role;
        roles[r] = (roles[r] || 0) + 1;
      }
      console.log("Roles:", JSON.stringify(roles));

      const storageDir = cleanTestDir("06bc5eef-smoke");

      const { state, assembleResult } = await runPipeline(messages, storageDir, 100);

      expect(state.compressedWindows.length).toBeGreaterThanOrEqual(0);
      expect(assembleResult).toBeDefined();
    },
    1_200_000, // 20 min
  );

  it(
    "session 06bc5eef: full test with LLM",
    async () => {
      const filename = "06bc5eef-dc76-45d8-8ad7-af34816fe5f7.jsonl.reset.2026-04-06T20-12-53.300Z";
      const messages = loadSessionFile(filename);
      console.log(`\n[Session 06bc5eef] Loaded ${messages.length} messages`);

      const roles: Record<string, number> = {};
      for (const m of messages) {
        const r = (m as { role: string }).role;
        roles[r] = (roles[r] || 0) + 1;
      }
      console.log("Roles:", JSON.stringify(roles));

      const storageDir = cleanTestDir("06bc5eef");

      const { state, assembleResult } = await runPipeline(messages, storageDir, 200);

      expect(state.compressedWindows.length).toBeGreaterThan(0);
      expect(assembleResult.systemPromptAddition).toBeDefined();
    },
    3_600_000,
  );

  it(
    "session a4572a02: load and process with LLM",
    async () => {
      const filename = "a4572a02-3a86-446c-b98c-0a0e25cbf4af.jsonl.reset.2026-03-23T23-10-01.829Z";
      const messages = loadSessionFile(filename);
      console.log(`\n[Session a4572a02] Loaded ${messages.length} messages`);

      const roles: Record<string, number> = {};
      for (const m of messages) {
        const r = (m as { role: string }).role;
        roles[r] = (roles[r] || 0) + 1;
      }
      console.log("Roles:", JSON.stringify(roles));

      const storageDir = cleanTestDir("a4572a02");

      const { state, assembleResult } = await runPipeline(messages, storageDir, 200);

      expect(state.compressedWindows.length).toBeGreaterThan(0);
      expect(assembleResult.systemPromptAddition).toBeDefined();
    },
    3_600_000,
  );
});
