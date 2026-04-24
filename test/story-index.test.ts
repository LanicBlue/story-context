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
  TEST_DB_SCHEMA, makeStorySummary, makeSimilarVectors,
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
  describe("story creation", () => {
    it("creates new story from summary", async () => {
      const db = openDb("session-1");
      const mgr = new StoryIndexManager(db, storyStorage, "session-1");

      const summary = makeStorySummary();
      await mgr.processSummaries([summary]);

      const stories = mgr.getAllStories();
      expect(stories).toHaveLength(1);
      expect(stories[0].attributes.subject).toBe(SUBJECTS.authModule);
      expect(stories[0].narrative).toContain("auth");
      expect(stories[0].sources).toHaveLength(1);

      mgr.close();
      db.close();
    });
  });

  describe("merging", () => {
    it("merges matching stories (normalized match)", async () => {
      const db = openDb("session-1");
      const mgr = new StoryIndexManager(db, storyStorage, "session-1");

      const summary1 = makeStorySummary();
      const summary2 = makeStorySummary({
        content: "Completed JWT implementation",
        sourceSummary: "summaries/2026-04-21-1.md",
        messageRange: [5, 10],
      });

      await mgr.processSummaries([summary1]);
      await mgr.processSummaries([summary2]);

      const stories = mgr.getAllStories();
      expect(stories).toHaveLength(1);
      expect(stories[0].sources).toHaveLength(2);
      expect(stories[0].narrative).toContain("auth");
      expect(stories[0].narrative).toContain("JWT");

      mgr.close();
      db.close();
    });

    it("creates separate stories for different attributes", async () => {
      const db = openDb("session-1");
      const mgr = new StoryIndexManager(db, storyStorage, "session-1");

      const summary1 = makeStorySummary();
      const summary2 = makeStorySummary({
        content: "Investigated database issue",
        attributes: {
          subject: SUBJECTS.authModule,
          type: TYPES.debugging,
          scenario: SCENARIOS.systemOps,
        },
        sourceSummary: "summaries/2026-04-21-1.md",
      });

      await mgr.processSummaries([summary1, summary2]);

      const stories = mgr.getAllStories();
      expect(stories).toHaveLength(2);
      mgr.close();
      db.close();
    });

    it("merges stories with comma-separated dimension", async () => {
      const db = openDb("session-1");
      const mgr = new StoryIndexManager(db, storyStorage, "session-1");

      const summary1 = makeStorySummary({
        attributes: { subject: SUBJECTS.authModule, type: TYPES.implementation, scenario: SCENARIOS.softwareCoding },
      });
      const summary2 = makeStorySummary({
        attributes: { subject: SUBJECTS.authModule, type: `${TYPES.implementation},${TYPES.debugging}`, scenario: `${SCENARIOS.softwareCoding}，${SCENARIOS.systemOps}` },
        sourceSummary: "summaries/2026-04-21-1.md",
      });

      await mgr.processSummaries([summary1, summary2]);

      const stories = mgr.getAllStories();
      expect(stories).toHaveLength(1);
      mgr.close();
      db.close();
    });
  });

  describe("entities", () => {
    it("creates entity documents for each dimension", async () => {
      const db = openDb("session-1");
      const mgr = new StoryIndexManager(db, storyStorage, "session-1");

      await mgr.processSummaries([makeStorySummary()]);

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
  });

  describe("persistence", () => {
    it("persists to SQLite and survives across manager instances", async () => {
      const sessionId = "session-1";
      const db = openDb(sessionId);

      const mgr1 = new StoryIndexManager(db, storyStorage, sessionId);
      await mgr1.processSummaries([makeStorySummary()]);
      const stories1 = mgr1.getAllStories();
      expect(stories1).toHaveLength(1);
      mgr1.close();

      const mgr2 = new StoryIndexManager(db, storyStorage, sessionId);
      mgr2.close();
      db.close();
    });

    it("tracks processed summaries", async () => {
      const db = openDb("session-1");
      const mgr = new StoryIndexManager(db, storyStorage, "session-1");

      expect(mgr.isProcessed("summaries/2026-04-21-0.md")).toBe(false);

      await mgr.processSummaries([makeStorySummary()]);

      expect(mgr.isProcessed("summaries/2026-04-21-0.md")).toBe(true);
      mgr.close();
      db.close();
    });

    it("handles multiple summaries in one batch", async () => {
      const db = openDb("session-1");
      const mgr = new StoryIndexManager(db, storyStorage, "session-1");

      const summaries = [
        makeStorySummary({ attributes: { subject: "project-a", type: TYPES.implementation, scenario: SCENARIOS.softwareCoding } }),
        makeStorySummary({ attributes: { subject: "project-b", type: TYPES.exploration, scenario: SCENARIOS.dataEngineering } }),
        makeStorySummary({ attributes: { subject: "project-a", type: TYPES.implementation, scenario: SCENARIOS.softwareCoding } }),
      ];

      await mgr.processSummaries(summaries);

      const stories = mgr.getAllStories();
      expect(stories).toHaveLength(2);
      mgr.close();
      db.close();
    });

    it("returns active stories sorted by last update", async () => {
      const db = openDb("session-1");
      const mgr = new StoryIndexManager(db, storyStorage, "session-1");

      await mgr.processSummaries([makeStorySummary()]);
      const active = mgr.getActiveStories();
      expect(active.length).toBeGreaterThan(0);
      expect(active[0].status).toBe("active");

      mgr.close();
      db.close();
    });
  });

  describe("semantic matching with embeddings", () => {
    it("merges stories via embedding when exact match fails", async () => {
      const db = openDb("semantic-1");
      const [vecA, vecB] = makeSimilarVectors(0.95);
      const mockEmbed = {
        embed: async (text: string) => {
          return text.includes("auth") ? vecA : vecB;
        },
      };

      const mgr = new StoryIndexManager(db, storyStorage, "semantic-1", undefined, mockEmbed as any, 0.85);

      await mgr.processSummaries([makeStorySummary()]);

      const newSummary = makeStorySummary({
        content: "Completed authentication system",
        attributes: {
          subject: "authentication",
          type: TYPES.implementation,
          scenario: SCENARIOS.softwareCoding,
        },
        sourceSummary: "summaries/2026-04-21-1.md",
      });

      await mgr.processSummaries([newSummary]);

      const stories = mgr.getAllStories();
      expect(stories).toHaveLength(1);
      expect(stories[0].narrative).toContain("JWT");
      expect(stories[0].narrative).toContain("authentication system");

      mgr.close();
      db.close();
    });

    it("does not merge when similarity is below threshold", async () => {
      const db = openDb("semantic-2");
      const [vecA, vecB] = makeSimilarVectors(0.5);
      const mockEmbed = {
        embed: async (text: string) => {
          return text === "auth-module" ? vecA : vecB;
        },
      };

      const mgr = new StoryIndexManager(db, storyStorage, "semantic-2", undefined, mockEmbed as any, 0.85);

      await mgr.processSummaries([makeStorySummary()]);
      await mgr.processSummaries([makeStorySummary({
        content: "Unrelated work",
        attributes: {
          subject: "database-migration",
          type: TYPES.implementation,
          scenario: SCENARIOS.softwareCoding,
        },
        sourceSummary: "summaries/2026-04-21-1.md",
      })]);

      const stories = mgr.getAllStories();
      expect(stories).toHaveLength(2);

      mgr.close();
      db.close();
    });

    it("falls back to exact match when no embeddingService", async () => {
      const db = openDb("semantic-3");
      const mgr = new StoryIndexManager(db, storyStorage, "semantic-3");

      await mgr.processSummaries([makeStorySummary()]);
      await mgr.processSummaries([makeStorySummary({
        content: "Different subject",
        attributes: {
          subject: "authentication",
          type: TYPES.implementation,
          scenario: SCENARIOS.softwareCoding,
        },
        sourceSummary: "summaries/2026-04-21-1.md",
      })]);

      const stories = mgr.getAllStories();
      expect(stories).toHaveLength(2);

      mgr.close();
      db.close();
    });

    it("requires type and scenario to match for semantic merge", async () => {
      const db = openDb("semantic-4");
      const [vecA, vecB] = makeSimilarVectors(0.95);
      const mockEmbed = {
        embed: async (text: string) => {
          return text.includes("auth") ? vecA : vecB;
        },
      };

      const mgr = new StoryIndexManager(db, storyStorage, "semantic-4", undefined, mockEmbed as any, 0.85);

      await mgr.processSummaries([makeStorySummary()]);
      await mgr.processSummaries([makeStorySummary({
        content: "Debugged auth",
        attributes: {
          subject: "authentication",
          type: TYPES.debugging,
          scenario: SCENARIOS.softwareCoding,
        },
        sourceSummary: "summaries/2026-04-21-1.md",
      })]);

      const stories = mgr.getAllStories();
      expect(stories).toHaveLength(2);

      mgr.close();
      db.close();
    });
  });
});
