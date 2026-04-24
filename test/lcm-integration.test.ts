import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { SmartContextEngine } from "../src/engine.js";
import { loadConversation, printTree, TEST_OUTPUT_DIR } from "./test-data.js";

describe("SmartContextEngine with lcm.db data", () => {
  // Clean and create output dir before tests
  if (existsSync(TEST_OUTPUT_DIR)) {
    rmSync(TEST_OUTPUT_DIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_OUTPUT_DIR, { recursive: true });

  it(
    "conv 1: full pipeline with output to data/test-output/",
    async () => {
      const { messages, totalTokens, totalCount } = await loadConversation(1);
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
