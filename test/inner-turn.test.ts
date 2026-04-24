import { describe, it, expect, vi } from "vitest";
import { runInnerTurn, sampleMessagesText } from "../src/inner-turn.js";
import type { InnerTurnDeps } from "../src/inner-turn.js";
import type { StoryDocument } from "../src/story-types.js";
import type { StoryIndexManager } from "../src/story-index.js";
import type { Summarizer } from "../src/types.js";
import { TYPES, SCENARIOS, SUBJECTS, makeStoryDoc, makeMockSummarizer } from "./test-data.js";

function makeMockStoryManager(stories: StoryDocument[] = []) {
  const docs = new Map(stories.map(s => [s.id, { ...s }]));

  return {
    getAllStories: vi.fn(() => [...docs.values()]),
    getActiveStories: vi.fn(() => [...docs.values()].filter(s => s.status === "active")),
    getActiveStoriesByTurn: vi.fn((turn: number) =>
      [...docs.values()].filter(s => s.activeUntilTurn >= turn && s.status === "active"),
    ),
    getKnownDimensions: vi.fn(() => {
      const subjects = new Set<string>();
      const types = new Set<string>();
      const scenarios = new Set<string>();
      for (const d of docs.values()) {
        subjects.add(d.attributes.subject);
        types.add(d.attributes.type);
        scenarios.add(d.attributes.scenario);
      }
      return { subjects: [...subjects], types: [...types], scenarios: [...scenarios] };
    }),
    createStoryDirect: vi.fn((attrs: { subject: string; type: string; scenario: string; content: string }) => {
      const id = `story-${attrs.subject.slice(0, 4)}`;
      docs.set(id, {
        id,
        title: `${attrs.subject} — ${attrs.type}`,
        attributes: { subject: attrs.subject, type: attrs.type, scenario: attrs.scenario },
        sources: [],
        status: "active",
        narrative: attrs.content,
        activeUntilTurn: 100,
        lastEditedTurn: 60,
        createdAt: Date.now(),
        lastUpdated: Date.now(),
      });
      return id;
    }),
    updateStoryContentDirect: vi.fn((storyId: string, content: string) => {
      const doc = docs.get(storyId);
      if (doc) doc.narrative += `\n\n${content}`;
    }),
    removeStory: vi.fn((storyId: string) => { docs.delete(storyId); }),
    evictOverflow: vi.fn(),
    expireOldStories: vi.fn(),
  } as unknown as StoryIndexManager;
}

function makeDeps(overrides: Partial<InnerTurnDeps> = {}): InnerTurnDeps {
  return {
    summarizer: makeMockSummarizer([]),
    storyManager: makeMockStoryManager(),
    currentTurn: 60,
    activeStoryTTL: 40,
    maxActiveStories: 10,
    sampleMessages: () => "[user]: Fix the auth bug\n[assistant]: I fixed the token expiry.",
    sampleRawCleaned: () => [{ raw: "npm warn deprecated 123", cleaned: "" }],
    applyFilterRules: vi.fn(),
    ...overrides,
  };
}

// ── InnerTurnB Tests ──────────────────────────────────────────────

describe("InnerTurnB", () => {
  it("creates a new story when B outputs action=create", async () => {
    const summarizer = makeMockSummarizer([
      JSON.stringify({ actions: [{ action: "create", story: { subject: SUBJECTS.authModule, type: TYPES.debugging, scenario: SCENARIOS.softwareCoding, content: "Fixed token expiry bug." } }] }),
    ]);
    const storyManager = makeMockStoryManager();
    const deps = makeDeps({ summarizer, storyManager });

    const result = await runInnerTurn(deps);

    expect(result.success).toBe(true);
    expect(result.createdCount).toBe(1);
    expect(storyManager.createStoryDirect).toHaveBeenCalledOnce();
  });

  it("creates multiple stories with batch output", async () => {
    const summarizer = makeMockSummarizer([
      JSON.stringify({ actions: [
        { action: "create", story: { subject: SUBJECTS.authModule, type: TYPES.debugging, scenario: SCENARIOS.softwareCoding, content: "Fixed auth bug." } },
        { action: "create", story: { subject: SUBJECTS.crawlerPipeline, type: TYPES.implementation, scenario: SCENARIOS.softwareCoding, content: "Built crawler pipeline." } },
      ] }),
    ]);
    const storyManager = makeMockStoryManager();
    const deps = makeDeps({ summarizer, storyManager });

    const result = await runInnerTurn(deps);

    expect(result.success).toBe(true);
    expect(result.createdCount).toBe(2);
    expect(storyManager.createStoryDirect).toHaveBeenCalledTimes(2);
  });

  it("skips when B outputs empty actions", async () => {
    const summarizer = makeMockSummarizer(['{"actions":[]}']);
    const storyManager = makeMockStoryManager();
    const deps = makeDeps({ summarizer, storyManager });

    const result = await runInnerTurn(deps);

    expect(result.success).toBe(true);
    expect(result.createdCount).toBe(0);
    expect(result.updatedCount).toBe(0);
  });

  it("updates an existing story (triggers Round 2)", async () => {
    const existingStory = makeStoryDoc({ id: "story-abc12345" });
    const summarizer = makeMockSummarizer([
      // Round 1
      JSON.stringify({ actions: [{ action: "update", targetStoryId: "story-abc12345", updatedContent: "Also fixed refresh token.", append: true }] }),
      // Round 2 (confirm)
      JSON.stringify({ actions: [{ action: "update", targetStoryId: "story-abc12345", updatedContent: "Also fixed refresh token.", append: true }] }),
    ]);
    const storyManager = makeMockStoryManager([existingStory]);
    const deps = makeDeps({ summarizer, storyManager });

    const result = await runInnerTurn(deps);

    expect(result.success).toBe(true);
    expect(result.updatedCount).toBe(1);
    expect(storyManager.updateStoryContentDirect).toHaveBeenCalledWith(
      "story-abc12345", "Also fixed refresh token.", true, 60, 40,
    );
  });

  it("rolls back all operations when one fails (all-or-nothing)", async () => {
    const summarizer = makeMockSummarizer([
      JSON.stringify({ actions: [
        { action: "create", story: { subject: SUBJECTS.authModule, type: TYPES.debugging, scenario: SCENARIOS.softwareCoding, content: "Fixed auth." } },
        { action: "update", targetStoryId: "nonexistent", updatedContent: "Update", append: true },
      ] }),
    ]);
    const storyManager = makeMockStoryManager();
    // updateStoryContentDirect throws for nonexistent story
    (storyManager.updateStoryContentDirect as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("Story nonexistent not found");
    });

    const deps = makeDeps({ summarizer, storyManager });
    const result = await runInnerTurn(deps);

    expect(result.success).toBe(false);
    // Rollback should have been called for the created story
    expect(storyManager.removeStory).toHaveBeenCalled();
  });
});

// ── InnerTurnA Tests ──────────────────────────────────────────────

describe("InnerTurnA (failure recovery)", () => {
  it("triggers A when B fails, A produces rules, B retries and succeeds", async () => {
    const summarizer = makeMockSummarizer([
      // B Round 1 - fails (invalid JSON)
      "not valid json",
      // A - produces rules
      JSON.stringify({ rules: [{ match: "contains", pattern: "npm warn", granularity: "message" }], reason: "Filter npm warnings" }),
      // B Round 2 (retry) - succeeds
      JSON.stringify({ actions: [{ action: "create", story: { subject: SUBJECTS.authModule, type: TYPES.debugging, scenario: SCENARIOS.softwareCoding, content: "Fixed auth." } }] }),
    ]);
    const storyManager = makeMockStoryManager();
    const deps = makeDeps({ summarizer, storyManager });

    const result = await runInnerTurn(deps);

    expect(result.success).toBe(true);
    expect(result.createdCount).toBe(1);
    expect(deps.applyFilterRules).toHaveBeenCalledWith([
      { match: "contains", pattern: "npm warn", granularity: "message" },
    ]);
  });

  it("gives up when A fails after 3 retries", async () => {
    // All B outputs invalid, all A outputs invalid
    const summarizer = makeMockSummarizer([
      "bad json", // B fails
      "also bad", // A fails
      "still bad", // A retry 1
      "nope", // A retry 2
      "not json either", // A retry 3 → give up
    ]);
    const storyManager = makeMockStoryManager();
    const deps = makeDeps({ summarizer, storyManager });

    const result = await runInnerTurn(deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain("A failed");
  });

  it("gives up when B fails after 3 retries even with A succeeding", async () => {
    const summarizer = makeMockSummarizer([
      // Attempt 1: B fails, A succeeds
      "bad", JSON.stringify({ rules: [{ match: "contains", pattern: "x", granularity: "message" }], reason: "" }),
      // Attempt 2: B fails, A succeeds
      "bad", JSON.stringify({ rules: [{ match: "contains", pattern: "y", granularity: "message" }], reason: "" }),
      // Attempt 3: B fails, A succeeds
      "bad", JSON.stringify({ rules: [{ match: "contains", pattern: "z", granularity: "message" }], reason: "" }),
    ]);
    const storyManager = makeMockStoryManager();
    const deps = makeDeps({ summarizer, storyManager });

    const result = await runInnerTurn(deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain("B failed after retries");
  });
});

// ── Active Story Lifecycle Tests ──────────────────────────────────

describe("Active Story lifecycle", () => {
  it("sets active TTL on create", async () => {
    const summarizer = makeMockSummarizer([
      JSON.stringify({ actions: [{ action: "create", story: { subject: SUBJECTS.authModule, type: TYPES.debugging, scenario: SCENARIOS.softwareCoding, content: "Fixed." } }] }),
    ]);
    const storyManager = makeMockStoryManager();
    const deps = makeDeps({ summarizer, storyManager, currentTurn: 60, activeStoryTTL: 40 });

    await runInnerTurn(deps);

    expect(storyManager.createStoryDirect).toHaveBeenCalledWith(
      expect.objectContaining({ subject: SUBJECTS.authModule }),
      60, // currentTurn
      40, // activeStoryTTL
    );
  });

  it("resets active TTL on update", async () => {
    const existing = makeStoryDoc({ id: "story-test", activeUntilTurn: 50, lastEditedTurn: 10 });
    const summarizer = makeMockSummarizer([
      JSON.stringify({ actions: [{ action: "update", targetStoryId: "story-test", updatedContent: "New info.", append: true }] }),
      JSON.stringify({ actions: [{ action: "update", targetStoryId: "story-test", updatedContent: "New info.", append: true }] }),
    ]);
    const storyManager = makeMockStoryManager([existing]);
    const deps = makeDeps({ summarizer, storyManager, currentTurn: 60, activeStoryTTL: 40 });

    await runInnerTurn(deps);

    expect(storyManager.updateStoryContentDirect).toHaveBeenCalledWith(
      "story-test", "New info.", true, 60, 40,
    );
  });

  it("calls evictOverflow after batch execution", async () => {
    const summarizer = makeMockSummarizer([
      JSON.stringify({ actions: [{ action: "create", story: { subject: "a", type: TYPES.implementation, scenario: SCENARIOS.softwareCoding, content: "C1" } }] }),
    ]);
    const storyManager = makeMockStoryManager();
    const deps = makeDeps({ summarizer, storyManager, maxActiveStories: 5 });

    await runInnerTurn(deps);

    expect(storyManager.evictOverflow).toHaveBeenCalledWith(5, 60);
  });
});

// ── Message Sampling Tests ────────────────────────────────────────

describe("sampleMessagesText", () => {
  it("formats messages with role prefix", () => {
    const messages = [
      { role: "user", content: "Fix the bug", timestamp: Date.now() },
      { role: "assistant", content: "I fixed it by changing the auth logic", timestamp: Date.now() },
    ];

    const result = sampleMessagesText(messages, 10);

    expect(result).toContain("[user]: Fix the bug");
    expect(result).toContain("[assistant]: I fixed it by changing the auth logic");
  });

  it("truncates long messages", () => {
    const messages = [
      { role: "user", content: "x".repeat(500), timestamp: Date.now() },
    ];

    const result = sampleMessagesText(messages, 10);

    expect(result.length).toBeLessThan(300);
  });

  it("respects limit parameter", () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      role: "user" as const,
      content: `msg ${i}`,
      timestamp: Date.now(),
    }));

    const result = sampleMessagesText(messages, 5);

    const lines = result.split("\n").filter(Boolean);
    expect(lines.length).toBe(5);
    expect(lines[4]).toContain("msg 49"); // last 5
  });
});
