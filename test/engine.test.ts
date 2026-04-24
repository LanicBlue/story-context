import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SmartContextEngine } from "../src/engine.js";
import type { Summarizer } from "../src/types.js";
import { SID, makeMessage, makeToolResult, makeMockSummarizer } from "./test-data.js";

let testDir: string;
let engine: SmartContextEngine | undefined;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "engine-test-"));
});

afterEach(async () => {
  if (engine) await engine.dispose();
  await rm(testDir, { recursive: true, force: true });
});

function makeEngine(config: Record<string, unknown> = {}, summarizer?: Summarizer) {
  engine = new SmartContextEngine({ storageDir: testDir, sessionFilter: "all", ...config }, summarizer);
  return engine;
}

describe("SmartContextEngine", () => {
  it("reports correct engine info", () => {
    const engine = makeEngine();
    expect(engine.info.id).toBe("story-context");
    expect(engine.info.version).toBe("2.0.0");
    expect(engine.info.ownsCompaction).toBe(true);
  });

  it("ingests user messages", async () => {
    const engine = makeEngine();
    await engine.ingest({ sessionId: SID, message: makeMessage("user", "implement binary search") });
    expect(engine._getState(SID)!.messages.length).toBe(1);
  });

  it("tracks read_file in seenReads", async () => {
    const engine = makeEngine();
    await engine.ingest({ sessionId: SID, message: makeToolResult("read_file", "contents", { path: "foo.ts" }) });
    expect(engine._getState(SID)!.seenReads.has("foo.ts")).toBe(true);
  });

  it("removes seenReads on write_file", async () => {
    const engine = makeEngine();
    await engine.ingest({ sessionId: SID, message: makeToolResult("read_file", "old", { path: "bar.ts" }) });
    expect(engine._getState(SID)!.seenReads.has("bar.ts")).toBe(true);
    await engine.ingest({ sessionId: SID, message: makeToolResult("write_file", "wrote", { path: "bar.ts" }) });
    expect(engine._getState(SID)!.seenReads.has("bar.ts")).toBe(false);
  });

  it("initializes session state correctly", async () => {
    const engine = makeEngine();
    await engine.ingest({ sessionId: SID, message: makeMessage("user", "test") });
    const state = engine._getState(SID)!;
    expect(state.activeEnd).toBe(0);
    expect(state.compressedWindows).toEqual([]);
    expect(state.focusedStoryId).toBeNull();
  });

  it("isolates different sessions", async () => {
    const engine = makeEngine();
    await engine.ingest({ sessionId: "a", message: makeMessage("user", "task A") });
    await engine.ingest({ sessionId: "b", message: makeMessage("user", "task B") });
    expect(engine._getState("a")!.messages.length).toBe(1);
    expect(engine._getState("b")!.messages.length).toBe(1);
  });

  it("dispose clears all sessions", async () => {
    const eng = makeEngine();
    await eng.ingest({ sessionId: "dispose-test", message: makeMessage("user", "hello") });
    await eng.dispose();
    expect(eng._getState("dispose-test")).toBeUndefined();
    engine = undefined; // already disposed
  });
});

describe("afterTurn", () => {
  it("strips platform metadata from user messages", async () => {
    const engine = makeEngine();
    await engine.ingest({
      sessionId: SID,
      message: makeMessage("user", "Conversation info (untrusted metadata):\n```json\n{\"id\":1}\n```\nActual message"),
    });
    await engine.afterTurn({ sessionId: SID, sessionFile: "" });
    const state = engine._getState(SID)!;
    const msg = state.messages[0] as { content: string };
    expect(msg.content).not.toContain("untrusted metadata");
    expect(msg.content).toContain("Actual message");
  });

  it("drops messages matching filter rules", async () => {
    const engine = makeEngine({
      contentFilters: [{ match: "contains", pattern: "verbose debug", granularity: "message" }],
    });
    await engine.ingest({ sessionId: SID, message: makeMessage("assistant", "verbose debug output") });
    await engine.afterTurn({ sessionId: SID, sessionFile: "" });
    expect((engine._getState(SID)!.messages[0] as Record<string, unknown>)._dropped).toBe(true);
  });

  it("increments turn counter", async () => {
    const engine = makeEngine();
    await engine.ingest({ sessionId: SID, message: makeMessage("user", "hello") });
    await engine.afterTurn({ sessionId: SID, sessionFile: "" });
    expect(engine._getState(SID)!.currentTurn).toBe(1);
    await engine.ingest({ sessionId: SID, message: makeMessage("user", "hello again") });
    await engine.afterTurn({ sessionId: SID, sessionFile: "" });
    expect(engine._getState(SID)!.currentTurn).toBe(2);
  });

  it("MicroCompacts old large tool results", async () => {
    const engine = makeEngine({ largeTextThreshold: 10 });
    await engine.ingest({ sessionId: SID, message: makeToolResult("run_shell", "x".repeat(50)) });
    await engine.afterTurn({ sessionId: SID, sessionFile: "" });
    // Second turn triggers MicroCompact for the first turn's tool result
    await engine.ingest({ sessionId: SID, message: makeMessage("user", "next turn") });
    await engine.afterTurn({ sessionId: SID, sessionFile: "" });
    const state = engine._getState(SID)!;
    const oldToolResult = state.messages[0] as { content: string };
    expect(oldToolResult.content).toBe("[Old tool result content cleared]");
  });
});

describe("compact", () => {
  function fillSession(engine: SmartContextEngine, sessionId: string, count: number, contentSize = 50) {
    const promises = [];
    for (let i = 0; i < count; i++) {
      promises.push(engine.ingest({
        sessionId,
        message: makeMessage(i % 2 === 0 ? "user" : "assistant", `Message ${i} with ${"x".repeat(contentSize)} content`),
      }));
    }
    return Promise.all(promises);
  }

  it("returns compacted:false when within budget", async () => {
    const engine = makeEngine({ maxHistoryTokens: 12_500 });
    await fillSession(engine, SID, 3);
    const result = await engine.compact({ sessionId: SID, sessionFile: "" });
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("within budget");
  });

  it("compresses old messages into a window", async () => {
    const engine = makeEngine({ maxHistoryTokens: 125, compactCoreTokens: 75, compactOverlapTokens: 12 });
    await fillSession(engine, SID, 20, 50);
    const result = await engine.compact({ sessionId: SID, sessionFile: "" });
    expect(result.compacted).toBe(true);
    expect(result.result!.tokensAfter!).toBeLessThan(result.result!.tokensBefore);
    const state = engine._getState(SID)!;
    expect(state.compressedWindows.length).toBeGreaterThan(0);
    expect(state.activeEnd).toBeGreaterThan(0);
  });

  it("uses structural summary (no LLM in compact)", async () => {
    const mock = makeMockSummarizer([]);
    const engine = makeEngine({ maxHistoryTokens: 125, compactCoreTokens: 75, compactOverlapTokens: 12 }, mock);
    await fillSession(engine, SID, 20, 50);
    await engine.compact({ sessionId: SID, sessionFile: "" });
    expect(mock.rawGenerate).not.toHaveBeenCalled();
  });

  it("handles force compact", async () => {
    const engine = makeEngine({ maxHistoryTokens: 12_500, compactCoreTokens: 75 });
    await fillSession(engine, SID, 10);
    const result = await engine.compact({ sessionId: SID, sessionFile: "", force: true });
    expect(result.compacted).toBe(true);
  });
});

describe("assemble", () => {
  it("returns messages within budget", async () => {
    const engine = makeEngine({ maxHistoryTokens: 125 });
    await engine.ingest({ sessionId: SID, message: makeMessage("user", "x".repeat(400)) });
    await engine.ingest({ sessionId: SID, message: makeMessage("assistant", "y".repeat(400)) });
    const result = await engine.assemble({ sessionId: SID, messages: [] });
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it("deduplicates old read_file results", async () => {
    const engine = makeEngine({ maxHistoryTokens: 12_500, recentWindowSize: 2 });
    await engine.ingest({ sessionId: SID, message: makeToolResult("read_file", "first read", { path: "x.ts" }) });
    await engine.ingest({ sessionId: SID, message: makeToolResult("read_file", "second read", { path: "x.ts" }) });
    await engine.ingest({ sessionId: SID, message: makeMessage("user", "recent q") });
    await engine.ingest({ sessionId: SID, message: makeMessage("assistant", "recent a") });
    const result = await engine.assemble({ sessionId: SID, messages: [] });
    expect(result.messages.length).toBe(3);
  });

  it("includes summary context after compaction", async () => {
    const engine = makeEngine({ maxHistoryTokens: 125, compactCoreTokens: 75, compactOverlapTokens: 12 });
    for (let i = 0; i < 10; i++) {
      await engine.ingest({ sessionId: SID, message: makeMessage("user", `Message ${i}: ${"x".repeat(200)}`) });
    }
    await engine.compact({ sessionId: SID, sessionFile: "" });
    const result = await engine.assemble({ sessionId: SID, messages: [] });
    const state = engine._getState(SID)!;
    if (state.compressedWindows.length > 0) {
      expect(result.systemPromptAddition).toBeDefined();
    }
  });
});

describe("session filtering", () => {
  it("processes main session by default", async () => {
    const engine = makeEngine({ sessionFilter: undefined });
    await engine.ingest({ sessionId: SID, sessionKey: "agent:main:main", message: makeMessage("user", "hello") });
    expect(engine._getState(SID)!.messages.length).toBe(1);
  });

  it("skips non-main session by default", async () => {
    const engine = makeEngine({ sessionFilter: undefined });
    await engine.ingest({ sessionId: "sub", sessionKey: "agent:main:slack:workspace:direct:user123", message: makeMessage("user", "hello") });
    expect(engine._getState("sub")).toBeUndefined();
  });

  it("processes all sessions when sessionFilter is 'all'", async () => {
    const engine = makeEngine();
    await engine.ingest({ sessionId: "sub", sessionKey: "agent:main:slack:workspace:direct:user123", message: makeMessage("user", "hello") });
    expect(engine._getState("sub")!.messages.length).toBe(1);
  });

  it("processes sessions matching regex patterns", async () => {
    const engine = makeEngine({ sessionFilter: ["agent:ops:.*"] });
    await engine.ingest({ sessionId: "ops", sessionKey: "agent:ops:main", message: makeMessage("user", "ops task") });
    expect(engine._getState("ops")!.messages.length).toBe(1);
  });

  it("skips sessions not matching regex patterns", async () => {
    const engine = makeEngine({ sessionFilter: ["agent:ops:.*"] });
    await engine.ingest({ sessionId: "main", sessionKey: "agent:main:main", message: makeMessage("user", "main task") });
    expect(engine._getState("main")).toBeUndefined();
  });
});

describe("focus stories", () => {
  it("focusStory sets focusedStoryId", () => {
    const engine = makeEngine();
    engine.ingest({ sessionId: SID, message: makeMessage("user", "test") });
    engine.focusStory(SID, "story-abc123");
    expect(engine._getState(SID)!.focusedStoryId).toBe("story-abc123");
  });

  it("unfocusStory clears focusedStoryId", () => {
    const engine = makeEngine();
    engine.ingest({ sessionId: SID, message: makeMessage("user", "test") });
    engine.focusStory(SID, "story-abc123");
    engine.unfocusStory(SID);
    expect(engine._getState(SID)!.focusedStoryId).toBeNull();
  });
});
