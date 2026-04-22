import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { SmartContextEngine } from "../src/engine.js";

const LCM_DB_PATH = join(import.meta.dirname, "..", "data", "lcm.db");
const TEST_OUTPUT_DIR = join(import.meta.dirname, "..", "data", "test-output");

/** Map lcm.db messages to our engine's message format. */
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

  // Get tool parts
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

/** Print directory tree for inspection. */
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

describe("SmartContextEngine with lcm.db data", () => {
  // Clean and create output dir before tests
  if (existsSync(TEST_OUTPUT_DIR)) {
    rmSync(TEST_OUTPUT_DIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_OUTPUT_DIR, { recursive: true });

  it(
    "conv 1: full pipeline with output to data/test-output/",
    async () => {
      const { messages, totalTokens, totalCount } = loadConversation(1);
      console.log(`Loaded ${messages.length} messages (${totalTokens.toLocaleString()} tokens)`);

      const engine = new SmartContextEngine({
        maxHistoryTokens: 16_000,
        compactCoreTokens: 6000,
        compactOverlapTokens: 1000,
        largeTextThreshold: 10_000,
        sessionFilter: "all",
        storageDir: TEST_OUTPUT_DIR,
      });

      // Ingest in batches, compact periodically
      const BATCH = 500;
      let compactCount = 0;

      for (let i = 0; i < messages.length; i += BATCH) {
        const batch = messages.slice(i, i + BATCH);
        for (const msg of batch) {
          await engine.ingest({ sessionId: "conv-1", message: msg });
        }

        const cr = await engine.compact({ sessionId: "conv-1", sessionFile: "" });
        if (cr.compacted) {
          compactCount++;
          const state = engine._getState("conv-1")!;
          if (compactCount % 10 === 0) {
            console.log(
              `Batch ${Math.floor(i / BATCH) + 1}: windows=${state.compressedWindows.length}, ` +
              `stories=${state.activeStories.length}`,
            );
          }
        }
      }

      const state = engine._getState("conv-1")!;
      console.log(`\n=== Final State ===`);
      console.log(`Messages: ${state.messages.length}`);
      console.log(`Compressed windows: ${state.compressedWindows.length}`);
      console.log(`Active stories: ${state.activeStories.length}`);

      // Compression stats
      let totalOriginal = 0;
      let totalCompressed = 0;
      for (const w of state.compressedWindows) {
        totalOriginal += w.originalChars;
        totalCompressed += w.compressedChars;
      }
      console.log(`\nCompression: ${(totalOriginal / 1000).toFixed(0)}K → ${(totalCompressed / 1000).toFixed(0)}K chars (${(totalCompressed / totalOriginal * 100).toFixed(1)}%)`);

      // Assemble
      const assembleResult = await engine.assemble({ sessionId: "conv-1", messages: [] });
      console.log(`\nAssemble: ${assembleResult.messages.length} msgs, ${assembleResult.estimatedTokens} tokens`);
      if (assembleResult.systemPromptAddition) {
        console.log(`systemPromptAddition: ${assembleResult.systemPromptAddition.length} chars`);
      }

      // Print output tree
      console.log(`\n=== Output Directory: ${TEST_OUTPUT_DIR}/conv-1/ ===`);
      printTree(join(TEST_OUTPUT_DIR, "conv-1"));

      // Show a sample summary file
      const summariesDir = join(TEST_OUTPUT_DIR, "conv-1", "summaries");
      if (existsSync(summariesDir)) {
        const files = readdirSync(summariesDir);
        if (files.length > 0) {
          const sample = readFileSync(join(summariesDir, files[0]), "utf-8");
          console.log(`\n--- Sample summary: ${files[0]} (first 800 chars) ---`);
          console.log(sample.slice(0, 800));
        }
      }

      // Show a sample story file
      const storiesDir = join(TEST_OUTPUT_DIR, "conv-1", "stories");
      if (existsSync(storiesDir)) {
        const files = readdirSync(storiesDir);
        if (files.length > 0) {
          const sample = readFileSync(join(storiesDir, files[0]), "utf-8");
          console.log(`\n--- Sample story: ${files[0]} (first 800 chars) ---`);
          console.log(sample.slice(0, 800));
        }
      }

      expect(state.compressedWindows.length).toBeGreaterThan(5);
      expect(assembleResult.systemPromptAddition).toBeDefined();

      // Don't dispose — keep files for inspection
    },
    300_000,
  );
});
