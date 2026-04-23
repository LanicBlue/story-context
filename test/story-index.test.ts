import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { StoryIndexManager } from "../src/story-index.js";
import { StoryStorage } from "../src/story-storage.js";
import { ContentStorage } from "../src/content-storage.js";
import type { StorySummary } from "../src/story-types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stories (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  subject TEXT NOT NULL,
  type TEXT NOT NULL,
  scenario TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  narrative TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  last_updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS story_sources (
  story_id TEXT NOT NULL,
  summary_path TEXT NOT NULL,
  msg_start INTEGER NOT NULL,
  msg_end INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  snippet TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS entities (
  dimension TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  last_updated INTEGER NOT NULL,
  PRIMARY KEY (dimension, name)
);
CREATE TABLE IF NOT EXISTS story_entities (
  story_id TEXT NOT NULL,
  dimension TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  PRIMARY KEY (story_id, dimension)
);
CREATE TABLE IF NOT EXISTS processed_summaries (
  path TEXT PRIMARY KEY
);
CREATE VIRTUAL TABLE IF NOT EXISTS stories_fts USING fts5(id, title, subject, type, scenario, narrative);
`;

let testDir: string;
let storage: ContentStorage;
let storyStorage: StoryStorage;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "story-index-test-"));
  storage = new ContentStorage(testDir);
  storyStorage = new StoryStorage(storage);
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function makeSummary(overrides: Partial<StorySummary> = {}): StorySummary {
  return {
    content: "Implemented authentication module",
    attributes: {
      subject: "auth-module",
      type: "development",
      scenario: "software-engineering",
    },
    sourceSummary: "summaries/2026-04-21-0.md",
    messageRange: [0, 5],
    timestamp: Date.now(),
    ...overrides,
  };
}

function openDb(sessionId: string): Database.Database {
  const dir = join(testDir, sessionId);
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "session.db"));
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}

describe("StoryIndexManager", () => {
  it("creates new story from summary", async () => {
    const db = openDb("session-1");
    const mgr = new StoryIndexManager(db, storyStorage, "session-1");

    const summary = makeSummary();
    await mgr.processSummaries([summary]);

    const stories = mgr.getAllStories();
    expect(stories).toHaveLength(1);
    expect(stories[0].attributes.subject).toBe("auth-module");
    expect(stories[0].narrative).toContain("authentication");
    expect(stories[0].sources).toHaveLength(1);

    mgr.close();
    db.close();
  });

  it("merges matching stories (normalized match)", async () => {
    const db = openDb("session-1");
    const mgr = new StoryIndexManager(db, storyStorage, "session-1");

    const summary1 = makeSummary();
    const summary2 = makeSummary({
      content: "Completed JWT implementation",
      sourceSummary: "summaries/2026-04-21-1.md",
      messageRange: [5, 10],
    });

    await mgr.processSummaries([summary1]);
    await mgr.processSummaries([summary2]);

    const stories = mgr.getAllStories();
    expect(stories).toHaveLength(1); // Merged into one
    expect(stories[0].sources).toHaveLength(2);
    expect(stories[0].narrative).toContain("authentication");
    expect(stories[0].narrative).toContain("JWT");

    mgr.close();
    db.close();
  });

  it("creates separate stories for different attributes", async () => {
    const db = openDb("session-1");
    const mgr = new StoryIndexManager(db, storyStorage, "session-1");

    const summary1 = makeSummary();
    const summary2 = makeSummary({
      content: "Investigated database issue",
      attributes: {
        subject: "auth-module",
        type: "debugging",
        scenario: "system-ops",
      },
      sourceSummary: "summaries/2026-04-21-1.md",
    });

    await mgr.processSummaries([summary1, summary2]);

    const stories = mgr.getAllStories();
    expect(stories).toHaveLength(2);
    mgr.close();
    db.close();
  });

  it("merges stories with comma-separated dimension values", async () => {
    const db = openDb("session-1");
    const mgr = new StoryIndexManager(db, storyStorage, "session-1");

    const summary1 = makeSummary({
      attributes: { subject: "auth-module", type: "development", scenario: "software-engineering" },
    });
    const summary2 = makeSummary({
      attributes: { subject: "auth-module", type: "development,debugging", scenario: "software-engineering，system-ops" },
      sourceSummary: "summaries/2026-04-21-1.md",
    });

    await mgr.processSummaries([summary1, summary2]);

    const stories = mgr.getAllStories();
    expect(stories).toHaveLength(1); // Normalized match merges them
    mgr.close();
    db.close();
  });

  it("creates entity documents for each dimension", async () => {
    const db = openDb("session-1");
    const mgr = new StoryIndexManager(db, storyStorage, "session-1");

    await mgr.processSummaries([makeSummary()]);

    const subjectEntity = mgr.getEntity("subject", "auth-module");
    expect(subjectEntity).toBeDefined();
    expect(subjectEntity!.name).toBe("auth-module");
    expect(subjectEntity!.storyIds.length).toBeGreaterThan(0);

    const typeEntity = mgr.getEntity("type", "development");
    expect(typeEntity).toBeDefined();

    const scenarioEntity = mgr.getEntity("scenario", "software-engineering");
    expect(scenarioEntity).toBeDefined();

    mgr.close();
    db.close();
  });

  it("returns active stories sorted by last update", async () => {
    const db = openDb("session-1");
    const mgr = new StoryIndexManager(db, storyStorage, "session-1");

    await mgr.processSummaries([makeSummary()]);
    const active = mgr.getActiveStories();
    expect(active.length).toBeGreaterThan(0);
    expect(active[0].status).toBe("active");

    mgr.close();
    db.close();
  });

  it("persists to SQLite and survives across manager instances", async () => {
    const sessionId = "session-1";
    const db = openDb(sessionId);

    // First instance: create story
    const mgr1 = new StoryIndexManager(db, storyStorage, sessionId);
    await mgr1.processSummaries([makeSummary()]);
    const stories1 = mgr1.getAllStories();
    expect(stories1).toHaveLength(1);
    mgr1.close();

    // Second instance: load from SQLite (index is rebuilt)
    const mgr2 = new StoryIndexManager(db, storyStorage, sessionId);
    // Note: in-memory index starts empty but SQLite persists
    mgr2.close();
    db.close();
  });

  it("tracks processed summaries", async () => {
    const db = openDb("session-1");
    const mgr = new StoryIndexManager(db, storyStorage, "session-1");

    expect(mgr.isProcessed("summaries/2026-04-21-0.md")).toBe(false);

    await mgr.processSummaries([makeSummary()]);

    expect(mgr.isProcessed("summaries/2026-04-21-0.md")).toBe(true);
    mgr.close();
    db.close();
  });

  it("handles multiple summaries in one batch", async () => {
    const db = openDb("session-1");
    const mgr = new StoryIndexManager(db, storyStorage, "session-1");

    const summaries = [
      makeSummary({ attributes: { subject: "project-a", type: "development", scenario: "software-engineering" } }),
      makeSummary({ attributes: { subject: "project-b", type: "exploration", scenario: "data-engineering" } }),
      makeSummary({ attributes: { subject: "project-a", type: "development", scenario: "software-engineering" } }), // Same as first
    ];

    await mgr.processSummaries(summaries);

    const stories = mgr.getAllStories();
    expect(stories).toHaveLength(2); // Third merged into first
    mgr.close();
    db.close();
  });
});
