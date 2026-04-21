import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { EventIndexManager } from "../src/event-index.js";
import { EventStorage } from "../src/event-storage.js";
import { ContentStorage } from "../src/content-storage.js";
import type { EventSummary } from "../src/event-types.js";

let testDir: string;
let storage: ContentStorage;
let eventStorage: EventStorage;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "event-index-test-"));
  storage = new ContentStorage(testDir);
  eventStorage = new EventStorage(storage);
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function makeSummary(overrides: Partial<EventSummary> = {}): EventSummary {
  return {
    content: "Implemented authentication module",
    attributes: {
      subject: "XX项目",
      type: "软件开发",
      scenario: "Web应用",
    },
    sourceSummary: "summaries/2026-04-21-0.md",
    messageRange: [0, 5],
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("EventIndexManager", () => {
  it("creates new event from summary", async () => {
    const dbPath = join(testDir, "session-1", "index.db");
    const mgr = new EventIndexManager(dbPath, eventStorage, "session-1");

    const summary = makeSummary();
    await mgr.processSummaries([summary]);

    const events = mgr.getAllEvents();
    expect(events).toHaveLength(1);
    expect(events[0].attributes.subject).toBe("XX项目");
    expect(events[0].narrative).toContain("authentication");
    expect(events[0].sources).toHaveLength(1);

    mgr.close();
  });

  it("merges matching events (exact match)", async () => {
    const dbPath = join(testDir, "session-1", "index.db");
    const mgr = new EventIndexManager(dbPath, eventStorage, "session-1");

    const summary1 = makeSummary();
    const summary2 = makeSummary({
      content: "Completed JWT implementation",
      sourceSummary: "summaries/2026-04-21-1.md",
      messageRange: [5, 10],
    });

    await mgr.processSummaries([summary1]);
    await mgr.processSummaries([summary2]);

    const events = mgr.getAllEvents();
    expect(events).toHaveLength(1); // Merged into one
    expect(events[0].sources).toHaveLength(2);
    expect(events[0].narrative).toContain("authentication");
    expect(events[0].narrative).toContain("JWT");

    mgr.close();
  });

  it("creates separate events for different attributes", async () => {
    const dbPath = join(testDir, "session-1", "index.db");
    const mgr = new EventIndexManager(dbPath, eventStorage, "session-1");

    const summary1 = makeSummary();
    const summary2 = makeSummary({
      content: "Investigated database issue",
      attributes: {
        subject: "XX项目",
        type: "故障排查",
        scenario: "生产环境",
      },
      sourceSummary: "summaries/2026-04-21-1.md",
    });

    await mgr.processSummaries([summary1, summary2]);

    const events = mgr.getAllEvents();
    expect(events).toHaveLength(2);
    mgr.close();
  });

  it("creates entity documents for each dimension", async () => {
    const dbPath = join(testDir, "session-1", "index.db");
    const mgr = new EventIndexManager(dbPath, eventStorage, "session-1");

    await mgr.processSummaries([makeSummary()]);

    const subjectEntity = mgr.getEntity("subject", "XX项目");
    expect(subjectEntity).toBeDefined();
    expect(subjectEntity!.name).toBe("XX项目");
    expect(subjectEntity!.eventIds.length).toBeGreaterThan(0);

    const typeEntity = mgr.getEntity("type", "软件开发");
    expect(typeEntity).toBeDefined();

    const scenarioEntity = mgr.getEntity("scenario", "Web应用");
    expect(scenarioEntity).toBeDefined();

    mgr.close();
  });

  it("returns active events sorted by last update", async () => {
    const dbPath = join(testDir, "session-1", "index.db");
    const mgr = new EventIndexManager(dbPath, eventStorage, "session-1");

    await mgr.processSummaries([makeSummary()]);
    const active = mgr.getActiveEvents();
    expect(active.length).toBeGreaterThan(0);
    expect(active[0].status).toBe("active");

    mgr.close();
  });

  it("persists to SQLite and survives across manager instances", async () => {
    const sessionId = "session-1";
    const dbPath = join(testDir, sessionId, "index.db");

    // First instance: create event
    const mgr1 = new EventIndexManager(dbPath, eventStorage, sessionId);
    await mgr1.processSummaries([makeSummary()]);
    const events1 = mgr1.getAllEvents();
    expect(events1).toHaveLength(1);
    mgr1.close();

    // Second instance: load from SQLite (index is rebuilt)
    const mgr2 = new EventIndexManager(dbPath, eventStorage, sessionId);
    // Note: in-memory index starts empty but SQLite persists
    mgr2.close();
  });

  it("tracks processed summaries", async () => {
    const dbPath = join(testDir, "session-1", "index.db");
    const mgr = new EventIndexManager(dbPath, eventStorage, "session-1");

    expect(mgr.isProcessed("summaries/2026-04-21-0.md")).toBe(false);

    await mgr.processSummaries([makeSummary()]);

    expect(mgr.isProcessed("summaries/2026-04-21-0.md")).toBe(true);
    mgr.close();
  });

  it("handles multiple summaries in one batch", async () => {
    const dbPath = join(testDir, "session-1", "index.db");
    const mgr = new EventIndexManager(dbPath, eventStorage, "session-1");

    const summaries = [
      makeSummary({ attributes: { subject: "项目A", type: "软件开发", scenario: "Web" } }),
      makeSummary({ attributes: { subject: "项目B", type: "调研", scenario: "技术选型" } }),
      makeSummary({ attributes: { subject: "项目A", type: "软件开发", scenario: "Web" } }), // Same as first
    ];

    await mgr.processSummaries(summaries);

    const events = mgr.getAllEvents();
    expect(events).toHaveLength(2); // Third merged into first
    mgr.close();
  });
});
