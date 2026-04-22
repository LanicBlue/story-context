import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { SmartContextEngine } from "../src/engine.js";
import { HttpSummarizer } from "../src/summarizer.js";

const LCM_DB_PATH = join(import.meta.dirname, "..", "data", "lcm.db");
const TEST_OUTPUT_DIR = join(import.meta.dirname, "..", "data", "llm-test-output");

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

function loadConversation(convId: number, opts?: { limit?: number; offset?: number }): {
  messages: Array<Record<string, unknown>>;
  totalTokens: number;
  totalCount: number;
} {
  const db = new Database(LCM_DB_PATH, { readonly: true });

  const limit = opts?.limit;
  const offset = opts?.offset ?? 0;

  let sql = `SELECT message_id, seq, role, content, token_count
       FROM messages
       WHERE conversation_id = ?
       ORDER BY seq`;
  const params: Array<number> = [convId];
  if (limit) {
    sql += ` LIMIT ? OFFSET ?`;
    params.push(limit, offset);
  }

  const messages = db.prepare(sql).all(...params) as Array<{
    message_id: number;
    seq: number;
    role: string;
    content: string;
    token_count: number;
  }>;

  const totalCount = (
    db
      .prepare("SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?")
      .get(convId) as { c: number }
  ).c;
  const totalTokens = (
    db
      .prepare("SELECT SUM(token_count) as t FROM messages WHERE conversation_id = ?")
      .get(convId) as { t: number | null }
  ).t ?? 0;

  const msgIds = messages.map((m) => m.message_id);
  const toolParts = new Map<
    number,
    Array<{ tool_name: string; tool_input: string; tool_output: string }>
  >();

  if (msgIds.length > 0) {
    const placeholders = msgIds.map(() => "?").join(",");
    const partRows = db
      .prepare(
        `SELECT message_id, tool_name, tool_input, tool_output
         FROM message_parts
         WHERE part_type = 'tool' AND message_id IN (${placeholders})`,
      )
      .all(...msgIds) as Array<{
      message_id: number;
      tool_name: string;
      tool_input: string;
      tool_output: string;
    }>;

    for (const p of partRows) {
      if (!toolParts.has(p.message_id)) toolParts.set(p.message_id, []);
      toolParts.get(p.message_id)!.push(p);
    }
  }

  db.close();

  const result: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    if (msg.role === "tool") {
      const parts = toolParts.get(msg.message_id) ?? [];
      if (parts.length > 0) {
        for (const part of parts) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(part.tool_input || "{}"); } catch { /* ignore */ }
          result.push({
            role: "toolResult",
            content: msg.content || part.tool_output || "",
            toolName: part.tool_name,
            args,
            timestamp: Date.now(),
          });
        }
      } else {
        result.push({
          role: "toolResult",
          content: msg.content || "",
          toolName: "unknown",
          args: {},
          timestamp: Date.now(),
        });
      }
    } else {
      result.push({
        role: msg.role as "user" | "assistant",
        content: msg.content || "",
        timestamp: Date.now(),
      });
    }
  }

  return { messages: result, totalTokens, totalCount };
}

function printTree(dir: string, prefix = "", depth = 0): void {
  if (depth > 3) return;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries.slice(0, 30)) {
    console.log(`${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`);
    if (entry.isDirectory()) {
      printTree(join(dir, entry.name), prefix + "  ", depth + 1);
    }
  }
  if (entries.length > 30) {
    console.log(`${prefix}... (${entries.length - 30} more)`);
  }
}

function getTestDir(name: string): string {
  return join(TEST_OUTPUT_DIR, name);
}

function cleanTestDir(name: string): string {
  const dir = getTestDir(name);
  if (existsSync(dir)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      try {
        const backup = dir + "-old-" + Date.now();
        require("fs").renameSync(dir, backup);
      } catch { /* give up cleaning */ }
    }
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function runPipeline(
  messages: Array<Record<string, unknown>>,
  storageDir: string,
  batchSize: number,
  onProgress?: (info: { batch: number; total: number; compactCount: number; state: unknown }) => void,
): Promise<{
  state: ReturnType<SmartContextEngine["_getState"]>;
  assembleResult: Awaited<ReturnType<SmartContextEngine["assemble"]>>;
  llmCallCount: number;
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

  const sessionId = "conv-1";
  let compactCount = 0;
  const totalBatches = Math.ceil(messages.length / batchSize);

  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize);

    // Ingest all messages in the batch (raw, only large tool outputs persisted)
    for (const msg of batch) {
      await engine.ingest({ sessionId, message: msg });
    }

    // AfterTurn: strip metadata, apply filters, MicroCompact old tool results
    await engine.afterTurn({ sessionId, sessionFile: "" });

    // Compact: compress and extract events
    const cr = await engine.compact({ sessionId, sessionFile: "" });
    if (cr.compacted) compactCount++;

    const batchNum = Math.floor(i / batchSize) + 1;
    const state = engine._getState(sessionId);
    if (batchNum % 5 === 0 || batchNum === totalBatches) {
      console.log(
        `[Batch ${batchNum}/${totalBatches}] compactions=${compactCount}, ` +
        `windows=${state?.compressedWindows.length ?? 0}, ` +
        `events=${state?.activeEvents.length ?? 0}, ` +
        `msgs processed=${i + batch.length}/${messages.length}`,
      );
    }

    if (onProgress) {
      onProgress({ batch: batchNum, total: totalBatches, compactCount, state });
    }
  }

  const state = engine._getState(sessionId)!;
  const assembleResult = await engine.assemble({ sessionId, messages: [] });

  console.log(`\n=== Final State ===`);
  console.log(`Messages remaining: ${state.messages.length}`);
  console.log(`Compressed windows: ${state.compressedWindows.length}`);
  console.log(`Active events: ${state.activeEvents.length}`);
  console.log(`Assemble: ${assembleResult.messages.length} msgs, ${assembleResult.estimatedTokens} tokens`);
  if (assembleResult.systemPromptAddition) {
    console.log(`systemPromptAddition: ${assembleResult.systemPromptAddition.length} chars`);
  }

  let totalOriginal = 0;
  let totalCompressed = 0;
  for (const w of state.compressedWindows) {
    totalOriginal += w.originalChars;
    totalCompressed += w.compressedChars;
  }
  if (totalOriginal > 0) {
    console.log(`Compression: ${(totalOriginal / 1000).toFixed(0)}K → ${(totalCompressed / 1000).toFixed(0)}K chars (${(totalCompressed / totalOriginal * 100).toFixed(1)}%)`);
  }

  return { state, assembleResult, llmCallCount: compactCount };
}

// ── Phase A: Smoke Test (~200 messages, ~5 min) ──────────────────────

describe("Phase A: LLM smoke test", () => {
  const storageDir = cleanTestDir("phase-a");

  it(
    "smoke test: 200 messages with LLM compression and event extraction",
    async () => {
      const { messages, totalTokens } = loadConversation(1, { limit: 200 });
      console.log(`\n[Phase A] Loaded ${messages.length} messages (${totalTokens.toLocaleString()} tokens)`);

      const { state, assembleResult } = await runPipeline(messages, storageDir, 100);

      expect(state.compressedWindows.length).toBeGreaterThan(0);

      console.log(`\n=== Output: ${storageDir}/conv-1/ ===`);
      printTree(join(storageDir, "conv-1"));

      const summariesDir = join(storageDir, "conv-1", "summaries");
      if (existsSync(summariesDir)) {
        const files = readdirSync(summariesDir);
        if (files.length > 0) {
          const sample = readFileSync(join(summariesDir, files[0]), "utf-8");
          console.log(`\n--- Sample summary: ${files[0]} (first 1000 chars) ---`);
          console.log(sample.slice(0, 1000));

          expect(sample).toContain("## ");
        }
      }

      const eventsDir = join(storageDir, "conv-1", "events");
      if (existsSync(eventsDir)) {
        const files = readdirSync(eventsDir);
        if (files.length > 0) {
          const sample = readFileSync(join(eventsDir, files[0]), "utf-8");
          console.log(`\n--- Sample event: ${files[0]} (first 1000 chars) ---`);
          console.log(sample.slice(0, 1000));
        }
      }

      expect(assembleResult.systemPromptAddition).toBeDefined();
    },
    1_200_000,
  );
});

// ── Phase B: Medium Scale (~2000 messages, ~30 min) ──────────────────

describe("Phase B: medium scale stability", () => {
  const storageDir = cleanTestDir("phase-b");

  it(
    "medium scale: 2000 messages with LLM, verify stability",
    async () => {
      const { messages, totalTokens } = loadConversation(1, { limit: 2000 });
      console.log(`\n[Phase B] Loaded ${messages.length} messages (${totalTokens.toLocaleString()} tokens)`);

      const { state, assembleResult } = await runPipeline(messages, storageDir, 500);

      expect(state.compressedWindows.length).toBeGreaterThan(5);

      const eventsDir = join(storageDir, "conv-1", "events");
      if (existsSync(eventsDir)) {
        const subjects = new Set<string>();
        const types = new Set<string>();
        const scenarios = new Set<string>();

        for (const file of readdirSync(eventsDir)) {
          const content = readFileSync(join(eventsDir, file), "utf-8");
          const subjectMatch = content.match(/^subject:\s*(.+)$/m);
          const typeMatch = content.match(/^type:\s*(.+)$/m);
          const scenarioMatch = content.match(/^scenario:\s*(.+)$/m);
          if (subjectMatch) subjects.add(subjectMatch[1].trim());
          if (typeMatch) types.add(typeMatch[1].trim());
          if (scenarioMatch) scenarios.add(scenarioMatch[1].trim());
        }

        console.log(`\nDimension diversity:`);
        console.log(`  Subjects: ${[...subjects].join(", ")}`);
        console.log(`  Types: ${[...types].join(", ")}`);
        console.log(`  Scenarios: ${[...scenarios].join(", ")}`);

        const nonTrivialSubjects = [...subjects].filter((s) => s !== "未知");
        console.log(`  Non-trivial subjects: ${nonTrivialSubjects.length}/${subjects.size}`);
      }

      expect(assembleResult.systemPromptAddition).toBeDefined();
    },
    3_600_000,
  );
});

// ── Phase C: Full Scale (27718 messages, 4-8 hours) ──────────────────

describe("Phase C: full scale", () => {
  const storageDir = cleanTestDir("phase-c");

  it(
    "full scale: all conv-1 messages with LLM",
    async () => {
      const { messages, totalTokens, totalCount } = loadConversation(1);
      console.log(`\n[Phase C] Loaded ${messages.length} messages (${totalTokens.toLocaleString()} tokens, total in db: ${totalCount})`);

      const startTime = Date.now();

      const { state, assembleResult } = await runPipeline(
        messages,
        storageDir,
        500,
        ({ batch, total, compactCount }) => {
          if (batch % 10 === 0) {
            const elapsed = (Date.now() - startTime) / 1000;
            const rate = batch / elapsed;
            const remaining = (total - batch) / rate;
            console.log(
              `[Progress] ${batch}/${total} batches, ` +
              `${compactCount} compactions, ` +
              `elapsed: ${(elapsed / 60).toFixed(1)}min, ` +
              `ETA: ${(remaining / 60).toFixed(1)}min`,
            );
          }
        },
      );

      const elapsed = (Date.now() - startTime) / 1000;
      console.log(`\nTotal time: ${(elapsed / 3600).toFixed(2)} hours`);

      expect(state.compressedWindows.length).toBeGreaterThan(50);
      expect(assembleResult.systemPromptAddition).toBeDefined();
      if (assembleResult.systemPromptAddition) {
        expect(assembleResult.systemPromptAddition.length).toBeLessThan(100_000);
      }
    },
    36_000_000,
  );
});
