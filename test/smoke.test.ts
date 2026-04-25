import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { SmartContextEngine } from "../src/engine.js";
import { HttpSummarizer } from "../src/summarizer.js";
import { loadJsonlConversation, printTree, TEST_OUTPUT_DIR } from "./test-data.js";

const OLLAMA_BASE_URL = "http://localhost:11435/v1";
const OLLAMA_MODEL = "qwen3:14b";

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

describe("Smoke test: full pipeline with LLM", () => {
  const outputDir = cleanDir(join(TEST_OUTPUT_DIR, "smoke"));

  it(
    "ingest → afterTurn → compact → assemble with story extraction",
    async () => {
      if (!await ollamaAvailable()) {
        console.log("Ollama not available — skipping");
        return;
      }

      const { messages, totalTokens } = loadJsonlConversation(0);
      console.log(`Loaded ${messages.length} messages (~${totalTokens.toLocaleString()} tokens)`);

      const summarizer = new HttpSummarizer({ baseUrl: OLLAMA_BASE_URL, model: OLLAMA_MODEL, timeoutMs: 180_000 });
      const engine = new SmartContextEngine({
        maxHistoryTokens: 16_000,
        messageWindowSize: 30,
        largeTextThreshold: 4_000,
        llmEnabled: true,
        sessionFilter: "all",
        storageDir: outputDir,
      }, summarizer);

      const sessionId = "session";
      const batchSize = 50;

      for (let i = 0; i < messages.length; i += batchSize) {
        const batch = messages.slice(i, i + batchSize);
        for (const msg of batch) await engine.ingest({ sessionId, message: msg });
        await engine.afterTurn({ sessionId, sessionFile: "" });

        for (let wait = 0; wait < 120; wait++) {
          const s = engine._getState(sessionId);
          if (!s?.innerTurnRunning) break;
          await new Promise(r => setTimeout(r, 1000));
        }

        const cr = await engine.compact({ sessionId, sessionFile: "" });

        const batchNum = Math.floor(i / batchSize) + 1;
        if (batchNum % 5 === 0 || i + batchSize >= messages.length) {
          const state = engine._getState(sessionId);
          console.log(
            `[Batch ${batchNum}] turn=${state?.currentTurn ?? 0}, ` +
            `compact=${cr.compacted}, ` +
            `stories=${state?.activeStories.length ?? 0}`,
          );
        }
      }

      const state = engine._getState(sessionId)!;
      console.log(`\nFinal: ${state.messages.length} msgs, ${state.activeStories.length} active stories, turn=${state.currentTurn}`);

      const assembleResult = await engine.assemble({ sessionId, messages: [] });
      console.log(`Assemble: ${assembleResult.messages.length} msgs, ${assembleResult.estimatedTokens} tokens`);
      if (assembleResult.systemPromptAddition) {
        console.log(`systemPromptAddition: ${assembleResult.systemPromptAddition.length} chars`);
      }

      console.log(`\n=== Output ===`);
      printTree(join(outputDir, sessionId));

      const storiesDir = join(outputDir, sessionId, "stories");
      const storyFiles = existsSync(storiesDir)
        ? readdirSync(storiesDir).filter(f => f.endsWith(".md")).sort()
        : [];
      console.log(`\nStories: ${storyFiles.length} files`);
      for (const f of storyFiles.slice(0, 5)) {
        console.log(`\n--- ${f} ---`);
        console.log(readFileSync(join(storiesDir, f), "utf-8").slice(0, 600));
      }

      // Assertions
      expect(state.messages.length).toBe(messages.length);
      expect(state.activeStories.length).toBeGreaterThan(0);
      expect(storyFiles.length).toBeGreaterThan(0);
      expect(assembleResult.estimatedTokens).toBeGreaterThan(0);
      expect(existsSync(join(outputDir, sessionId, "session.db"))).toBe(true);

      await engine.dispose();
    },
    1_800_000,
  );
});
