import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Compactor } from "../src/compactor.js";
import { ContentStorage } from "../src/content-storage.js";
import type { Summarizer } from "../src/types.js";
import { makeMessage, makeToolResult } from "./test-data.js";

let testDir: string;
let storage: ContentStorage;
let compactor: Compactor;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "compact-test-"));
  storage = new ContentStorage(testDir);
  compactor = new Compactor(storage);
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("Compactor.buildWindow", () => {
  it("builds window with core messages within budget", () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      makeMessage(i % 2 === 0 ? "user" : "assistant", `Message ${i}: ${"x".repeat(500)}`),
    );

    const window = compactor.buildWindow(messages, 0, { coreChars: 2000, overlapChars: 500 });
    expect(window.coreMessages.length).toBeGreaterThan(0);
    expect(window.coreTotalChars).toBeLessThanOrEqual(2000 * 1.15);
    expect(window.coreStartIdx).toBe(0);
    expect(window.coreEndIdx).toBeGreaterThan(0);
  });

  it("includes pre-overlap from message before active start", () => {
    const messages = [
      makeMessage("user", "before"),
      makeMessage("assistant", "a".repeat(500)),
      makeMessage("user", "b".repeat(500)),
    ];

    const window = compactor.buildWindow(messages, 1, { coreChars: 1000, overlapChars: 200 });
    expect(window.preOverlap).toContain("before");
  });

  it("includes post-overlap from message after core", () => {
    const messages = [
      makeMessage("user", "a".repeat(40)),
      makeMessage("assistant", "b".repeat(40)),
      makeMessage("user", "after this message"),
    ];

    const window = compactor.buildWindow(messages, 0, { coreChars: 50, overlapChars: 200 });
    expect(window.coreEndIdx).toBeLessThan(3);
    if (window.coreEndIdx < messages.length) {
      expect(window.postOverlap.length).toBeGreaterThan(0);
    }
  });

  it("truncates long pre-overlap to overlapChars", () => {
    const messages = [
      makeMessage("user", "x".repeat(2000)),
      makeMessage("assistant", "core content"),
    ];

    const window = compactor.buildWindow(messages, 1, { coreChars: 5000, overlapChars: 200 });
    expect(window.preOverlap.length).toBeLessThanOrEqual(203);
  });

  it("handles active start at 0 with no pre-overlap", () => {
    const messages = [makeMessage("user", "only message")];
    const window = compactor.buildWindow(messages, 0, { coreChars: 5000, overlapChars: 200 });
    expect(window.preOverlap).toBe("");
  });

  it("handles core at end of messages with no post-overlap", () => {
    const messages = [makeMessage("user", "last message")];
    const window = compactor.buildWindow(messages, 0, { coreChars: 5000, overlapChars: 200 });
    expect(window.postOverlap).toBe("");
  });
});

describe("Compactor.buildStructuralSummary", () => {
  it("extracts task from user messages", () => {
    const messages = [
      makeMessage("user", "Fix the bug in login.ts"),
      makeMessage("assistant", "Let me check the file"),
      makeToolResult("read_file", "file content", { path: "login.ts" }),
    ];

    const summary = compactor.buildStructuralSummary(messages);
    expect(summary).toContain("## Task Intent");
    expect(summary).toContain("Fix the bug in login.ts");
  });

  it("creates operation table from tool results", () => {
    const messages = [
      makeToolResult("read_file", "file contents", { path: "utils.ts" }),
      makeToolResult("write_file", "wrote file", { path: "utils.ts" }),
    ];

    const summary = compactor.buildStructuralSummary(messages);
    expect(summary).toContain("## Operations");
    expect(summary).toContain("read_file");
    expect(summary).toContain("utils.ts");
  });

  it("lists file changes for write operations", () => {
    const messages = [
      makeToolResult("write_file", "created", { path: "new-file.ts" }),
    ];

    const summary = compactor.buildStructuralSummary(messages);
    expect(summary).toContain("## File Changes");
    expect(summary).toContain("new-file.ts");
  });

  it("extracts conclusions from assistant messages", () => {
    const messages = [
      makeMessage("assistant", "The test passed successfully."),
    ];

    const summary = compactor.buildStructuralSummary(messages);
    expect(summary).toContain("test passed");
  });

  it("handles empty messages", () => {
    const summary = compactor.buildStructuralSummary([]);
    expect(summary).toContain("# Compressed Summary");
  });

  it("handles outline content in tool results", () => {
    const messages = [
      makeToolResult("run_shell", "[Stored: text/content-abc.txt | 450 lines | 4.9KB]\n--- Head ---\nline1"),
    ];

    const summary = compactor.buildStructuralSummary(messages);
    expect(summary).toContain("run_shell");
    expect(summary).toContain("[Stored:");
  });
});

describe("Compactor.compressWithLLM", () => {
  it("calls summarizer with formatted prompt", async () => {
    const promptCalls: string[] = [];
    const mockSummarizer: Summarizer = {
      summarize: async (text: string) => {
        promptCalls.push(text);
        return "# Compressed Summary\n## Task Intent\n- Test task";
      },
      rawGenerate: async () => "",
    };

    const c = new Compactor(storage, mockSummarizer);
    const result = await c.compressWithLLM(
      "previous context",
      "core content to compress",
      "following context",
      600,
    );

    expect(result).toContain("Task Intent");
    expect(promptCalls[0]).toContain("previous context");
    expect(promptCalls[0]).toContain("core content to compress");
    expect(promptCalls[0]).toContain("following context");
  });
});

describe("Compactor.saveSummary", () => {
  it("saves .md file to disk with date-based naming and returns metadata", async () => {
    const markdown = "# Compressed Summary\n## Task Intent\n- Test";
    const window = await compactor.saveSummary("sess-1", markdown, [0, 5], 3000);

    expect(window.storagePath).toMatch(/^summaries\/\d{4}-\d{2}-\d{2}-0\.md$/);
    expect(window.messageRange).toEqual([0, 5]);
    expect(window.originalChars).toBe(3000);
    expect(window.compressedChars).toBe(markdown.length);

    const content = await readFile(join(testDir, "sess-1", window.storagePath), "utf-8");
    expect(content).toBe(markdown);
  });

  it("increments index for multiple saves on same day", async () => {
    await compactor.saveSummary("sess-1", "first", [0, 3], 1000);
    const window = await compactor.saveSummary("sess-1", "second", [3, 6], 1500);
    expect(window.storagePath).toMatch(/-1\.md$/);
  });
});
