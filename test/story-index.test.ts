import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { StoryIndexManager } from "../src/story-index.js";
import { StoryStorage } from "../src/story-storage.js";
import { ContentStorage } from "../src/content-storage.js";
import {
  TYPES, SCENARIOS, SUBJECTS,
  TEST_DB_SCHEMA,
} from "./test-data.js";

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

function openDb(sessionId: string): Database.Database {
  const dir = join(testDir, sessionId);
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "session.db"));
  db.pragma("journal_mode = WAL");
  db.exec(TEST_DB_SCHEMA);
  return db;
}

describe("StoryIndexManager", () => {
  describe("createStoryDirect", () => {
    it("creates a story and returns its ID", () => {
      const db = openDb("session-1");
      const mgr = new StoryIndexManager(db, storyStorage, "session-1");

      const id = mgr.createStoryDirect({
        subject: SUBJECTS.authModule,
        type: TYPES.debugging,
        scenario: SCENARIOS.softwareCoding,
        content: "Fixed a bug in the auth module.",
      }, 1, 40);

      expect(id).toMatch(/^story-/);
      const stories = mgr.getAllStories();
      expect(stories).toHaveLength(1);
      expect(stories[0].attributes.subject).toBe(SUBJECTS.authModule);
      expect(stories[0].narrative).toContain("auth");
      expect(stories[0].activeUntilTurn).toBe(41); // currentTurn(1) + TTL(40)
      expect(stories[0].lastEditedTurn).toBe(1);

      mgr.close();
      db.close();
    });

    it("creates entity documents for each dimension", () => {
      const db = openDb("session-1");
      const mgr = new StoryIndexManager(db, storyStorage, "session-1");

      mgr.createStoryDirect({
        subject: SUBJECTS.authModule,
        type: TYPES.implementation,
        scenario: SCENARIOS.softwareCoding,
        content: "Built auth module.",
      }, 1, 40);

      const subjectEntity = mgr.getEntity("subject", SUBJECTS.authModule);
      expect(subjectEntity).toBeDefined();
      expect(subjectEntity!.name).toBe(SUBJECTS.authModule);
      expect(subjectEntity!.storyIds.length).toBeGreaterThan(0);

      const typeEntity = mgr.getEntity("type", TYPES.implementation);
      expect(typeEntity).toBeDefined();

      const scenarioEntity = mgr.getEntity("scenario", SCENARIOS.softwareCoding);
      expect(scenarioEntity).toBeDefined();

      mgr.close();
      db.close();
    });

    it("creates separate stories for different attributes", () => {
      const db = openDb("session-1");
      const mgr = new StoryIndexManager(db, storyStorage, "session-1");

      mgr.createStoryDirect({
        subject: SUBJECTS.authModule,
        type: TYPES.debugging,
        scenario: SCENARIOS.softwareCoding,
        content: "Fixed auth bug.",
      }, 1, 40);

      mgr.createStoryDirect({
        subject: SUBJECTS.crawlerPipeline,
        type: TYPES.implementation,
        scenario: SCENARIOS.dataCrawling,
        content: "Built crawler pipeline.",
      }, 1, 40);

      const stories = mgr.getAllStories();
      expect(stories).toHaveLength(2);

      mgr.close();
      db.close();
    });

    it("deduplicates stories with same attributes (same hash)", () => {
      const db = openDb("session-1");
      const mgr = new StoryIndexManager(db, storyStorage, "session-1");

      const id1 = mgr.createStoryDirect({
        subject: SUBJECTS.authModule,
        type: TYPES.implementation,
        scenario: SCENARIOS.softwareCoding,
        content: "First creation.",
      }, 1, 40);

      const id2 = mgr.createStoryDirect({
        subject: SUBJECTS.authModule,
        type: TYPES.implementation,
        scenario: SCENARIOS.softwareCoding,
        content: "Second creation (replaces first).",
      }, 2, 40);

      // Same attributes → same hash → same ID, so the doc is replaced
      expect(id1).toBe(id2);
      const stories = mgr.getAllStories();
      expect(stories).toHaveLength(1);
      expect(stories[0].narrative).toBe("Second creation (replaces first).");

      mgr.close();
      db.close();
    });
  });

  describe("updateStoryContentDirect", () => {
    it("appends content to existing story", () => {
      const db = openDb("session-1");
      const mgr = new StoryIndexManager(db, storyStorage, "session-1");

      const id = mgr.createStoryDirect({
        subject: SUBJECTS.authModule,
        type: TYPES.debugging,
        scenario: SCENARIOS.softwareCoding,
        content: "Initial narrative.",
      }, 1, 40);

      mgr.updateStoryContentDirect(id, "Also fixed refresh token.", true, 2, 40);

      const story = mgr.getAllStories()[0];
      expect(story.narrative).toContain("Initial narrative.");
      expect(story.narrative).toContain("Also fixed refresh token.");
      expect(story.activeUntilTurn).toBe(42); // currentTurn(2) + TTL(40)
      expect(story.lastEditedTurn).toBe(2);

      mgr.close();
      db.close();
    });

    it("replaces content when append=false", () => {
      const db = openDb("session-1");
      const mgr = new StoryIndexManager(db, storyStorage, "session-1");

      const id = mgr.createStoryDirect({
        subject: SUBJECTS.authModule,
        type: TYPES.debugging,
        scenario: SCENARIOS.softwareCoding,
        content: "Old content.",
      }, 1, 40);

      mgr.updateStoryContentDirect(id, "New content.", false, 2, 40);

      const story = mgr.getAllStories()[0];
      expect(story.narrative).toBe("New content.");
      expect(story.narrative).not.toContain("Old content.");

      mgr.close();
      db.close();
    });

    it("throws if story not found", () => {
      const db = openDb("session-1");
      const mgr = new StoryIndexManager(db, storyStorage, "session-1");

      expect(() => {
        mgr.updateStoryContentDirect("story-nonexistent", "content", true, 1, 40);
      }).toThrow("not found");

      mgr.close();
      db.close();
    });
  });

  describe("removeStory", () => {
    it("removes a story from the index", () => {
      const db = openDb("session-1");
      const mgr = new StoryIndexManager(db, storyStorage, "session-1");

      const id = mgr.createStoryDirect({
        subject: SUBJECTS.authModule,
        type: TYPES.implementation,
        scenario: SCENARIOS.softwareCoding,
        content: "Built auth.",
      }, 1, 40);

      expect(mgr.getAllStories()).toHaveLength(1);
      mgr.removeStory(id);
      expect(mgr.getAllStories()).toHaveLength(0);

      mgr.close();
      db.close();
    });
  });

  describe("active story lifecycle", () => {
    it("returns active stories by turn", () => {
      const db = openDb("session-1");
      const mgr = new StoryIndexManager(db, storyStorage, "session-1");

      mgr.createStoryDirect({
        subject: SUBJECTS.authModule,
        type: TYPES.implementation,
        scenario: SCENARIOS.softwareCoding,
        content: "Active story.",
      }, 10, 40);

      // Story is active until turn 50
      expect(mgr.getActiveStoriesByTurn(10)).toHaveLength(1);
      expect(mgr.getActiveStoriesByTurn(49)).toHaveLength(1);
      expect(mgr.getActiveStoriesByTurn(50)).toHaveLength(1);
      expect(mgr.getActiveStoriesByTurn(51)).toHaveLength(0);

      mgr.close();
      db.close();
    });

    it("expireOldStories sets activeUntilTurn to 0", () => {
      const db = openDb("session-1");
      const mgr = new StoryIndexManager(db, storyStorage, "session-1");

      mgr.createStoryDirect({
        subject: SUBJECTS.authModule,
        type: TYPES.implementation,
        scenario: SCENARIOS.softwareCoding,
        content: "Expiring story.",
      }, 10, 20);

      // Story active until turn 30
      expect(mgr.getActiveStoriesByTurn(25)).toHaveLength(1);

      mgr.expireOldStories(31);
      expect(mgr.getActiveStoriesByTurn(31)).toHaveLength(0);

      mgr.close();
      db.close();
    });

    it("evictOverflow removes oldest stories", () => {
      const db = openDb("session-1");
      const mgr = new StoryIndexManager(db, storyStorage, "session-1");

      // Create 5 stories
      for (let i = 0; i < 5; i++) {
        mgr.createStoryDirect({
          subject: `project-${i}`,
          type: TYPES.implementation,
          scenario: SCENARIOS.softwareCoding,
          content: `Story ${i}.`,
        }, i + 1, 100);
      }

      // All active at turn 5
      expect(mgr.getActiveStoriesByTurn(5)).toHaveLength(5);

      // Evict to keep only 3
      mgr.evictOverflow(3, 5);
      const active = mgr.getActiveStoriesByTurn(5);
      expect(active.length).toBe(3);
      // Should keep the newest (lastEditedTurn 5, 4, 3)
      expect(active.map(s => s.lastEditedTurn).sort()).toEqual([3, 4, 5]);

      mgr.close();
      db.close();
    });

    it("getActiveStories returns only active stories sorted by lastEditedTurn", () => {
      const db = openDb("session-1");
      const mgr = new StoryIndexManager(db, storyStorage, "session-1");

      mgr.createStoryDirect({
        subject: "a",
        type: TYPES.implementation,
        scenario: SCENARIOS.softwareCoding,
        content: "Story A.",
      }, 1, 100);

      mgr.createStoryDirect({
        subject: "b",
        type: TYPES.implementation,
        scenario: SCENARIOS.softwareCoding,
        content: "Story B.",
      }, 5, 100);

      const active = mgr.getActiveStories();
      expect(active).toHaveLength(2);
      // Sorted by lastEditedTurn desc (most recent first)
      expect(active[0].lastEditedTurn).toBe(5);
      expect(active[1].lastEditedTurn).toBe(1);

      mgr.close();
      db.close();
    });
  });

  describe("persistence", () => {
    it("persists to SQLite and survives loadFromDb", () => {
      const sessionId = "session-1";
      const db = openDb(sessionId);

      const mgr1 = new StoryIndexManager(db, storyStorage, sessionId);
      const id = mgr1.createStoryDirect({
        subject: SUBJECTS.authModule,
        type: TYPES.implementation,
        scenario: SCENARIOS.softwareCoding,
        content: "Built auth module.",
      }, 1, 40);
      mgr1.updateStoryContentDirect(id, "Also added JWT.", true, 2, 40);
      expect(mgr1.getAllStories()).toHaveLength(1);
      mgr1.close();

      const mgr2 = new StoryIndexManager(db, storyStorage, sessionId);
      mgr2.loadFromDb();
      const stories = mgr2.getAllStories();
      expect(stories).toHaveLength(1);
      expect(stories[0].narrative).toContain("Built auth module.");
      expect(stories[0].narrative).toContain("Also added JWT.");
      expect(stories[0].attributes.subject).toBe(SUBJECTS.authModule);

      mgr2.close();
      db.close();
    });

    it("getKnownDimensions returns distinct dimension values", () => {
      const db = openDb("session-1");
      const mgr = new StoryIndexManager(db, storyStorage, "session-1");

      mgr.createStoryDirect({
        subject: SUBJECTS.authModule,
        type: TYPES.implementation,
        scenario: SCENARIOS.softwareCoding,
        content: "Built auth.",
      }, 1, 40);

      mgr.createStoryDirect({
        subject: SUBJECTS.crawlerPipeline,
        type: TYPES.debugging,
        scenario: SCENARIOS.dataCrawling,
        content: "Fixed crawler.",
      }, 2, 40);

      const dims = mgr.getKnownDimensions();
      expect(dims.subjects).toHaveLength(2);
      expect(dims.types).toHaveLength(2);
      expect(dims.scenarios).toHaveLength(2);

      mgr.close();
      db.close();
    });
  });

  describe("entity linking", () => {
    it("links multiple stories to same entity", () => {
      const db = openDb("session-1");
      const mgr = new StoryIndexManager(db, storyStorage, "session-1");

      mgr.createStoryDirect({
        subject: SUBJECTS.authModule,
        type: TYPES.implementation,
        scenario: SCENARIOS.softwareCoding,
        content: "Built auth.",
      }, 1, 40);

      mgr.createStoryDirect({
        subject: SUBJECTS.authModule,
        type: TYPES.debugging,
        scenario: SCENARIOS.softwareCoding,
        content: "Fixed auth bug.",
      }, 2, 40);

      const entity = mgr.getEntity("subject", SUBJECTS.authModule);
      expect(entity).toBeDefined();
      expect(entity!.storyIds).toHaveLength(2);

      mgr.close();
      db.close();
    });
  });
});
