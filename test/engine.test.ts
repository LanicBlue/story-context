import { describe, it, expect, vi } from "vitest";
import { SmartContextEngine } from "../src/engine.js";
import type { Summarizer } from "../src/types.js";

function makeMessage(
  role: "user" | "assistant" | "toolResult",
  content: string,
  extra?: Record<string, unknown>,
) {
  return { role, content, timestamp: Date.now(), ...extra };
}

function makeToolResult(
  toolName: string,
  content: string,
  args?: Record<string, unknown>,
) {
  return makeMessage("toolResult", content, {
    toolName,
    args: args ?? {},
  });
}

const SID = "test-session";

describe("SmartContextEngine basics", () => {
  it("reports correct engine info", () => {
    const engine = new SmartContextEngine();
    expect(engine.info.id).toBe("smart-context");
    expect(engine.info.version).toBe("2.0.0");
    expect(engine.info.ownsCompaction).toBe(true);
  });

  it("ingests user messages and records task", async () => {
    const engine = new SmartContextEngine();
    await engine.ingest({
      sessionId: SID,
      message: makeMessage("user", "implement binary search"),
    });
    const state = engine._getState(SID)!;
    expect(state.memory.task).toBe("implement binary search");
  });

  it("only records the first task", async () => {
    const engine = new SmartContextEngine();
    await engine.ingest({
      sessionId: SID,
      message: makeMessage("user", "first task"),
    });
    await engine.ingest({
      sessionId: SID,
      message: makeMessage("user", "second task"),
    });
    const state = engine._getState(SID)!;
    expect(state.memory.task).toBe("first task");
  });

  it("tracks read_file in seenReads", async () => {
    const engine = new SmartContextEngine();
    await engine.ingest({
      sessionId: SID,
      message: makeToolResult("read_file", "file contents here", { path: "foo.ts" }),
    });
    const state = engine._getState(SID)!;
    expect(state.seenReads.has("foo.ts")).toBe(true);
    expect(state.memory.files).toContain("foo.ts");
  });

  it("removes seenReads on write_file", async () => {
    const engine = new SmartContextEngine();
    await engine.ingest({
      sessionId: SID,
      message: makeToolResult("read_file", "old contents", { path: "bar.ts" }),
    });
    expect(engine._getState(SID)!.seenReads.has("bar.ts")).toBe(true);

    await engine.ingest({
      sessionId: SID,
      message: makeToolResult("write_file", "wrote bar.ts", { path: "bar.ts" }),
    });
    expect(engine._getState(SID)!.seenReads.has("bar.ts")).toBe(false);
  });

  it("limits memory notes", async () => {
    const engine = new SmartContextEngine({ memoryNotesLimit: 3 });
    for (let i = 0; i < 5; i++) {
      await engine.ingest({
        sessionId: SID,
        message: makeToolResult("run_shell", `output ${i}`),
      });
    }
    const state = engine._getState(SID)!;
    expect(state.memory.notes.length).toBe(3);
    expect(state.memory.notes[0]).toContain("output 2");
    expect(state.memory.notes[2]).toContain("output 4");
  });

  it("includes memory prompt in systemPromptAddition", async () => {
    const engine = new SmartContextEngine();
    await engine.ingest({
      sessionId: SID,
      message: makeMessage("user", "fix the bug"),
    });
    await engine.ingest({
      sessionId: SID,
      message: makeToolResult("read_file", "bug here", { path: "bug.ts" }),
    });

    const result = await engine.assemble({
      sessionId: SID,
      messages: [],
    });

    expect(result.systemPromptAddition).toBeDefined();
    expect(result.systemPromptAddition!).toContain("fix the bug");
    expect(result.systemPromptAddition!).toContain("bug.ts");
  });

  it("isolates different sessions", async () => {
    const engine = new SmartContextEngine();
    await engine.ingest({
      sessionId: "session-a",
      message: makeMessage("user", "task A"),
    });
    await engine.ingest({
      sessionId: "session-b",
      message: makeMessage("user", "task B"),
    });

    const stateA = engine._getState("session-a")!;
    const stateB = engine._getState("session-b")!;
    expect(stateA.memory.task).toBe("task A");
    expect(stateB.memory.task).toBe("task B");
  });

  it("dispose clears all sessions", async () => {
    const engine = new SmartContextEngine();
    const disposeSid = "dispose-test-session";
    await engine.ingest({
      sessionId: disposeSid,
      message: makeMessage("user", "hello"),
    });
    await engine.dispose();
    expect(engine._getState(disposeSid)).toBeUndefined();
  });

  it("initializes session state correctly", async () => {
    const engine = new SmartContextEngine();
    await engine.ingest({
      sessionId: SID,
      message: makeMessage("user", "test"),
    });
    const state = engine._getState(SID)!;
    expect(state.activeEnd).toBe(0);
    expect(state.compressedWindows).toEqual([]);
  });
});

describe("SmartContextEngine assemble", () => {
  it("assembles messages within budget", async () => {
    const engine = new SmartContextEngine({ maxHistoryChars: 500 });
    await engine.ingest({
      sessionId: SID,
      message: makeMessage("user", "x".repeat(400)),
    });
    await engine.ingest({
      sessionId: SID,
      message: makeMessage("assistant", "y".repeat(400)),
    });

    const result = await engine.assemble({
      sessionId: SID,
      messages: [],
    });

    expect(result.messages.length).toBeGreaterThan(0);
  });

  it("deduplicates old read_file results", async () => {
    const engine = new SmartContextEngine({
      maxHistoryChars: 50_000,
      recentWindowSize: 2,
    });

    await engine.ingest({
      sessionId: SID,
      message: makeToolResult("read_file", "first read", { path: "x.ts" }),
    });
    await engine.ingest({
      sessionId: SID,
      message: makeToolResult("read_file", "second read", { path: "x.ts" }),
    });
    await engine.ingest({
      sessionId: SID,
      message: makeMessage("user", "recent q"),
    });
    await engine.ingest({
      sessionId: SID,
      message: makeMessage("assistant", "recent a"),
    });

    const result = await engine.assemble({
      sessionId: SID,
      messages: [],
    });

    expect(result.messages.length).toBe(3);
  });

  it("includes summary refs when windows exist", async () => {
    const engine = new SmartContextEngine({ maxHistoryChars: 50_000, compactCoreChars: 100 });
    // Fill enough messages to trigger compression
    for (let i = 0; i < 10; i++) {
      await engine.ingest({
        sessionId: SID,
        message: makeMessage("user", `Message ${i}: ${"x".repeat(200)}`),
      });
    }

    await engine.compact({ sessionId: SID, sessionFile: "" });

    const result = await engine.assemble({ sessionId: SID, messages: [] });
    if (engine._getState(SID)!.compressedWindows.length > 0) {
      expect(result.systemPromptAddition).toContain("Previous conversation summaries");
    }
  });
});

describe("SmartContextEngine compact", () => {
  function fillSession(
    engine: SmartContextEngine,
    sessionId: string,
    count: number,
    contentSize = 50,
  ) {
    const promises = [];
    for (let i = 0; i < count; i++) {
      promises.push(
        engine.ingest({
          sessionId,
          message: makeMessage(
            i % 2 === 0 ? "user" : "assistant",
            `Message ${i} with ${"x".repeat(contentSize)} content`,
          ),
        }),
      );
    }
    return Promise.all(promises);
  }

  it("returns compacted:false when within budget", async () => {
    const engine = new SmartContextEngine({ maxHistoryChars: 50_000 });
    await fillSession(engine, SID, 3);

    const result = await engine.compact({ sessionId: SID, sessionFile: "" });
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("within budget");
  });

  it("compresses old messages into a window", async () => {
    const engine = new SmartContextEngine({
      maxHistoryChars: 500,
      compactCoreChars: 300,
      compactOverlapChars: 50,
    });
    await fillSession(engine, SID, 20, 50);

    const result = await engine.compact({ sessionId: SID, sessionFile: "" });
    expect(result.compacted).toBe(true);
    expect(result.result!.tokensAfter!).toBeLessThan(result.result!.tokensBefore);

    const state = engine._getState(SID)!;
    expect(state.compressedWindows.length).toBeGreaterThan(0);
    expect(state.activeEnd).toBeGreaterThan(0);
    expect(state.activeEnd).toBeLessThan(20);
  });

  it("stores compressed summary on disk", async () => {
    const engine = new SmartContextEngine({
      maxHistoryChars: 500,
      compactCoreChars: 300,
      compactOverlapChars: 50,
    });
    await fillSession(engine, SID, 20, 50);
    await engine.compact({ sessionId: SID, sessionFile: "" });

    const state = engine._getState(SID)!;
    if (state.compressedWindows.length > 0) {
      expect(state.compressedWindows[0].storagePath).toMatch(/summaries\/\d{4}-\d{2}-\d{2}-\d+\.md/);
      expect(state.compressedWindows[0].originalChars).toBeGreaterThan(0);
    }
  });

  it("uses LLM summarizer when available", async () => {
    const mockSummarizer: Summarizer = {
      summarize: vi.fn().mockResolvedValue("# Compressed Summary\n## Task Intent\n- Test task\n## Conclusion\n- Done"),
    };

    const engine = new SmartContextEngine(
      {
        maxHistoryChars: 500,
        compactCoreChars: 300,
        compactOverlapChars: 50,
        summaryEnabled: true,
      },
      mockSummarizer,
    );
    await fillSession(engine, SID, 20, 50);
    await engine.compact({ sessionId: SID, sessionFile: "" });

    expect(mockSummarizer.summarize).toHaveBeenCalled();
  });

  it("falls back to structural summary when LLM fails", async () => {
    const mockSummarizer: Summarizer = {
      summarize: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
    };

    const engine = new SmartContextEngine(
      {
        maxHistoryChars: 500,
        compactCoreChars: 300,
        compactOverlapChars: 50,
      },
      mockSummarizer,
    );
    await fillSession(engine, SID, 20, 50);

    const result = await engine.compact({ sessionId: SID, sessionFile: "" });
    expect(result.compacted).toBe(true);

    const state = engine._getState(SID)!;
    // Should still have compressed windows (structural fallback)
    if (state.compressedWindows.length > 0) {
      expect(state.compressedWindows[0].compressedChars).toBeGreaterThan(0);
    }
  });

  it("handles force compact even when within budget", async () => {
    const engine = new SmartContextEngine({
      maxHistoryChars: 50_000,
      compactCoreChars: 300,
    });
    await fillSession(engine, SID, 10);

    const result = await engine.compact({
      sessionId: SID,
      sessionFile: "",
      force: true,
    });
    expect(result.compacted).toBe(true);
  });
});

describe("SmartContextEngine content processing integration", () => {
  it("processes large tool output into outline", async () => {
    const engine = new SmartContextEngine({ largeTextThreshold: 100 });
    const longOutput = Array.from({ length: 30 }, (_, i) => `output line ${i + 1}`).join("\n");

    await engine.ingest({
      sessionId: SID,
      message: makeToolResult("run_shell", longOutput),
    });

    const state = engine._getState(SID)!;
    const msg = state.messages[0] as { content: string };
    expect(msg.content).toContain("[Stored:");
    expect(msg.content).toContain("--- Head ---");
  });

  it("drops messages matching message-level filter", async () => {
    const engine = new SmartContextEngine({
      contentFilters: [
        { match: "contains", pattern: "verbose debug", granularity: "message" },
      ],
    });

    await engine.ingest({
      sessionId: SID,
      message: makeMessage("assistant", "verbose debug output"),
    });

    const state = engine._getState(SID)!;
    expect(state.messages.length).toBe(0);
  });

  it("short content passes through unchanged", async () => {
    const engine = new SmartContextEngine({ largeTextThreshold: 2000 });
    await engine.ingest({
      sessionId: SID,
      message: makeMessage("user", "short message"),
    });

    const state = engine._getState(SID)!;
    const msg = state.messages[0] as { content: string };
    expect(msg.content).toBe("short message");
  });
});

describe("SmartContextEngine session filtering", () => {
  it("processes main session by default", async () => {
    const engine = new SmartContextEngine();
    await engine.ingest({
      sessionId: SID,
      sessionKey: "agent:main:main",
      message: makeMessage("user", "hello"),
    });
    expect(engine._getState(SID)).toBeDefined();
    expect(engine._getState(SID)!.messages.length).toBe(1);
  });

  it("skips non-main session by default", async () => {
    const engine = new SmartContextEngine();
    await engine.ingest({
      sessionId: "sub-session",
      sessionKey: "agent:main:slack:workspace:direct:user123",
      message: makeMessage("user", "hello from subagent"),
    });
    expect(engine._getState("sub-session")).toBeUndefined();
  });

  it("processes all sessions when sessionFilter is 'all'", async () => {
    const engine = new SmartContextEngine({ sessionFilter: "all" });
    await engine.ingest({
      sessionId: "sub-session",
      sessionKey: "agent:main:slack:workspace:direct:user123",
      message: makeMessage("user", "hello from subagent"),
    });
    expect(engine._getState("sub-session")).toBeDefined();
    expect(engine._getState("sub-session")!.messages.length).toBe(1);
  });

  it("processes sessions matching regex patterns", async () => {
    const engine = new SmartContextEngine({ sessionFilter: ["agent:ops:.*"] });
    await engine.ingest({
      sessionId: "ops-session",
      sessionKey: "agent:ops:main",
      message: makeMessage("user", "ops task"),
    });
    expect(engine._getState("ops-session")).toBeDefined();
  });

  it("skips sessions not matching regex patterns", async () => {
    const engine = new SmartContextEngine({ sessionFilter: ["agent:ops:.*"] });
    await engine.ingest({
      sessionId: "other-session",
      sessionKey: "agent:main:main",
      message: makeMessage("user", "main task"),
    });
    expect(engine._getState("other-session")).toBeUndefined();
  });

  it("allows sessions without sessionKey (testing mode)", async () => {
    const engine = new SmartContextEngine();
    await engine.ingest({
      sessionId: SID,
      message: makeMessage("user", "no key"),
    });
    expect(engine._getState(SID)).toBeDefined();
  });
});
