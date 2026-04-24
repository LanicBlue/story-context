import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { SmartContextEngine } from "../src/engine.js";
import { HttpSummarizer } from "../src/summarizer.js";
import { loadJsonlConversation, printTree, TEST_OUTPUT_DIR } from "./test-data.js";

const OLLAMA_BASE_URL = "http://localhost:11434/v1";
const OLLAMA_MODEL = "qwen2.5:3b";

async function ollamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL.replace("/v1", "")}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

function cleanDir(dir: string): string {
  if (existsSync(dir)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked db on Windows */ }
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("Smoke test: full pipeline with JSONL data (no LLM)", () => {
  const outputDir = cleanDir(join(TEST_OUTPUT_DIR, "smoke"));

  it(
    "ingest → afterTurn → compact → assemble",
    async () => {
      const { messages, totalTokens } = loadJsonlConversation(0);
      console.log(`Loaded ${messages.length} messages (~${totalTokens.toLocaleString()} tokens)`);

      const engine = new SmartContextEngine({
        maxHistoryTokens: 16_000,
        compactCoreTokens: 6_000,
        compactOverlapTokens: 1_000,
        largeTextThreshold: 4_000,
        sessionFilter: "all",
        storageDir: outputDir,
      });

      const sessionId = "session";
      const batchSize = 50;
      let compactCount = 0;

      for (let i = 0; i < messages.length; i += batchSize) {
        const batch = messages.slice(i, i + batchSize);
        for (const msg of batch) await engine.ingest({ sessionId, message: msg });
        await engine.afterTurn({ sessionId, sessionFile: "" });
        const cr = await engine.compact({ sessionId, sessionFile: "" });
        if (cr.compacted) compactCount++;

        const batchNum = Math.floor(i / batchSize) + 1;
        if (batchNum % 10 === 0 || i + batchSize >= messages.length) {
          const state = engine._getState(sessionId);
          console.log(
            `[Batch ${batchNum}] compactions=${compactCount}, ` +
            `windows=${state?.compressedWindows.length ?? 0}, ` +
            `turn=${state?.currentTurn ?? 0}`,
          );
        }
      }

      const state = engine._getState(sessionId)!;
      console.log(`\nFinal: ${state.messages.length} msgs, ${state.compressedWindows.length} windows, turn=${state.currentTurn}`);

      // Compression stats
      let totalOriginal = 0;
      let totalCompressed = 0;
      for (const w of state.compressedWindows) {
        totalOriginal += w.originalChars;
        totalCompressed += w.compressedChars;
      }
      if (totalOriginal > 0) {
        console.log(`Compression: ${(totalOriginal / 1000).toFixed(0)}K → ${(totalCompressed / 1000).toFixed(0)}K chars (${(totalCompressed / totalOriginal * 100).toFixed(1)}%)`);
      }

      // Assemble
      const assembleResult = await engine.assemble({ sessionId, messages: [] });
      console.log(`Assemble: ${assembleResult.messages.length} msgs, ${assembleResult.estimatedTokens} tokens`);

      // Output tree
      console.log(`\n=== Output ===`);
      printTree(join(outputDir, sessionId));

      // Show sample summaries
      const summariesDir = join(outputDir, sessionId, "summaries");
      if (existsSync(summariesDir)) {
        const files = readdirSync(summariesDir).filter(f => f.endsWith(".md")).sort();
        console.log(`\nSummaries: ${files.length} files`);
        if (files.length > 0) {
          const sample = readFileSync(join(summariesDir, files[Math.floor(files.length / 2)]), "utf-8");
          console.log(`\n--- Sample: ${files[0]} (first 500 chars) ---`);
          console.log(sample.slice(0, 500));
        }
      }

      expect(state.compressedWindows.length).toBeGreaterThan(0);
      expect(compactCount).toBeGreaterThan(0);
      expect(assembleResult.estimatedTokens).toBeGreaterThan(0);
      expect(existsSync(join(outputDir, sessionId, "session.db"))).toBe(true);

      await engine.dispose();
    },
    300_000,
  );
});

describe("Smoke test: full pipeline with LLM (requires Ollama)", () => {
  const outputDir = cleanDir(join(TEST_OUTPUT_DIR, "smoke-llm"));

  it(
    "ingest → afterTurn → compact → assemble with story extraction",
    async () => {
      if (!await ollamaAvailable()) {
        console.log("Ollama not available, skipping LLM smoke test");
        return;
      }

      const { messages, totalTokens } = loadJsonlConversation(0, { limit: 500 });
      console.log(`Loaded ${messages.length} messages (~${totalTokens.toLocaleString()} tokens)`);

      const summarizer = new HttpSummarizer({ baseUrl: OLLAMA_BASE_URL, model: OLLAMA_MODEL, timeoutMs: 180_000 });
      const engine = new SmartContextEngine({
        maxHistoryTokens: 16_000,
        compactCoreTokens: 6_000,
        compactOverlapTokens: 1_000,
        largeTextThreshold: 4_000,
        summaryEnabled: true,
        sessionFilter: "all",
        storageDir: outputDir,
      }, summarizer);

      const sessionId = "session";
      const batchSize = 50;
      let compactCount = 0;

      for (let i = 0; i < messages.length; i += batchSize) {
        const batch = messages.slice(i, i + batchSize);
        for (const msg of batch) await engine.ingest({ sessionId, message: msg });
        await engine.afterTurn({ sessionId, sessionFile: "" });
        const cr = await engine.compact({ sessionId, sessionFile: "" });
        if (cr.compacted) compactCount++;

        const batchNum = Math.floor(i / batchSize) + 1;
        if (batchNum % 5 === 0 || i + batchSize >= messages.length) {
          const state = engine._getState(sessionId);
          console.log(
            `[Batch ${batchNum}] compactions=${compactCount}, ` +
            `windows=${state?.compressedWindows.length ?? 0}, ` +
            `stories=${state?.activeStories.length ?? 0}`,
          );
        }
      }

      const state = engine._getState(sessionId)!;
      console.log(`\nFinal: ${state.messages.length} msgs, ${state.compressedWindows.length} windows, ${state.activeStories.length} active stories`);

      // Assemble
      const assembleResult = await engine.assemble({ sessionId, messages: [] });
      console.log(`Assemble: ${assembleResult.messages.length} msgs, ${assembleResult.estimatedTokens} tokens`);
      if (assembleResult.systemPromptAddition) {
        console.log(`systemPromptAddition: ${assembleResult.systemPromptAddition.length} chars`);
      }

      // Output tree
      printTree(join(outputDir, sessionId));

      // Show stories
      const storiesDir = join(outputDir, sessionId, "stories");
      if (existsSync(storiesDir)) {
        const files = readdirSync(storiesDir).filter(f => f.endsWith(".md")).sort();
        console.log(`\nStories: ${files.length} files`);
        for (const f of files.slice(0, 3)) {
          console.log(`\n--- ${f} ---`);
          console.log(readFileSync(join(storiesDir, f), "utf-8").slice(0, 600));
        }
      }

      expect(state.compressedWindows.length).toBeGreaterThan(0);
      expect(assembleResult.estimatedTokens).toBeGreaterThan(0);

      await engine.dispose();
    },
    1_200_000,
  );
});
