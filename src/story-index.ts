import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type {
  StorySummary,
  StoryDocument,
  EntityDocument,
  StoryIndex,
} from "./story-types.js";
import { StoryStorage } from "./story-storage.js";
import type { Summarizer } from "./types.js";

type Dimension = "subject" | "type" | "scenario";

export class StoryIndexManager {
  private db: Database.Database;
  private readonly index: StoryIndex;

  constructor(
    db: Database.Database,
    private readonly storage: StoryStorage,
    private readonly sessionId: string,
    private readonly summarizer?: Summarizer,
  ) {
    this.db = db;
    this.index = {
      documents: new Map(),
      entities: new Map(),
      processedSummaries: new Set(),
    };
  }

  // ── Dimension Normalization ────────────────────────────────────────

  private normalizeDim(val: string): string {
    return val.split(/[,，、]/)[0].trim().toLowerCase();
  }

  // ── Story ID Generation ──────────────────────────────────────────

  private generateStoryId(attrs: { subject: string; type: string; scenario: string }): string {
    const payload = [this.normalizeDim(attrs.subject), this.normalizeDim(attrs.type), this.normalizeDim(attrs.scenario)].join("|");
    const hash = createHash("sha256").update(payload).digest("hex").slice(0, 8);
    return `story-${hash}`;
  }

  private entityKey(dimension: Dimension, name: string): string {
    return `${dimension}:${name}`;
  }

  // ── Process Story Summaries ──────────────────────────────────────

  /** Process extracted story summaries: match, create/update stories, update entities. */
  async processSummaries(summaries: StorySummary[]): Promise<void> {
    for (const summary of summaries) {
      const match = this.findMatch(summary);

      if (match) {
        await this.updateStory(match, summary);
      } else {
        await this.createStory(summary);
      }
    }
  }

  /** Find an existing story that matches all three dimensions (normalized). */
  private findMatch(summary: StorySummary): StoryDocument | undefined {
    const sS = this.normalizeDim(summary.attributes.subject);
    const sT = this.normalizeDim(summary.attributes.type);
    const sSc = this.normalizeDim(summary.attributes.scenario);
    for (const doc of this.index.documents.values()) {
      if (
        this.normalizeDim(doc.attributes.subject) === sS &&
        this.normalizeDim(doc.attributes.type) === sT &&
        this.normalizeDim(doc.attributes.scenario) === sSc
      ) {
        return doc;
      }
    }
    return undefined;
  }

  // ── Create / Update Stories ───────────────────────────────────────

  private async createStory(summary: StorySummary): Promise<void> {
    const id = this.generateStoryId(summary.attributes);
    const now = Date.now();
    const title = `${summary.attributes.subject} — ${summary.attributes.type}`;

    const doc: StoryDocument = {
      id,
      title,
      attributes: { ...summary.attributes },
      sources: [{
        summaryPath: summary.sourceSummary,
        messageRange: summary.messageRange,
        timestamp: summary.timestamp,
        snippet: summary.content.slice(0, 100),
      }],
      status: "active",
      narrative: summary.content,
      createdAt: now,
      lastUpdated: now,
    };

    // Persist to in-memory index
    this.index.documents.set(id, doc);
    this.index.processedSummaries.add(summary.sourceSummary);

    // Persist to SQLite
    this.persistStory(doc);
    this.persistStorySource(id, doc.sources[0]);
    this.persistProcessedSummary(summary.sourceSummary);

    // Ensure entities exist and link
    await this.ensureEntities(summary.attributes, id);

    // Persist .md
    await this.storage.writeStoryDocument(this.sessionId, doc);
  }

  private async updateStory(doc: StoryDocument, summary: StorySummary): Promise<void> {
    doc.sources.push({
      summaryPath: summary.sourceSummary,
      messageRange: summary.messageRange,
      timestamp: summary.timestamp,
      snippet: summary.content.slice(0, 100),
    });
    doc.narrative += `\n\n${summary.content}`;
    doc.lastUpdated = Date.now();
    this.index.processedSummaries.add(summary.sourceSummary);

    // Update SQLite
    this.persistStory(doc);
    this.persistStorySource(doc.id, doc.sources[doc.sources.length - 1]);
    this.persistProcessedSummary(summary.sourceSummary);

    // Persist .md
    await this.storage.writeStoryDocument(this.sessionId, doc);
  }

  // ── Entity Management ────────────────────────────────────────────

  private async ensureEntities(
    attrs: { subject: string; type: string; scenario: string },
    storyId: string,
  ): Promise<void> {
    const dimensions: Array<[Dimension, string]> = [
      ["subject", attrs.subject],
      ["type", attrs.type],
      ["scenario", attrs.scenario],
    ];

    for (const [dim, name] of dimensions) {
      const key = this.entityKey(dim, name);
      let entity = this.index.entities.get(key);

      if (!entity) {
        entity = {
          dimension: dim,
          name,
          description: "",
          storyIds: [storyId],
          relatedEntities: [],
          createdAt: Date.now(),
          lastUpdated: Date.now(),
        };
        this.index.entities.set(key, entity);
        this.persistEntity(entity);
      } else if (!entity.storyIds.includes(storyId)) {
        entity.storyIds.push(storyId);
        entity.lastUpdated = Date.now();
        this.persistEntity(entity);
      }

      // Link story to entity
      this.persistStoryEntity(storyId, dim, name);

      // Persist .md
      await this.storage.writeEntityDocument(this.sessionId, entity);
    }
  }

  // ── SQLite Persistence ───────────────────────────────────────────

  private persistStory(doc: StoryDocument): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO stories (id, title, subject, type, scenario, status, narrative, created_at, last_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      doc.id, doc.title, doc.attributes.subject, doc.attributes.type,
      doc.attributes.scenario, doc.status, doc.narrative, doc.createdAt, doc.lastUpdated,
    );

    // Update FTS
    this.db.prepare(`
      INSERT OR REPLACE INTO stories_fts (id, title, subject, type, scenario, narrative)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      doc.id, doc.title, doc.attributes.subject, doc.attributes.type,
      doc.attributes.scenario, doc.narrative,
    );
  }

  private persistStorySource(storyId: string, source: StoryDocument["sources"][0]): void {
    this.db.prepare(`
      INSERT INTO story_sources (story_id, summary_path, msg_start, msg_end, timestamp, snippet)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(storyId, source.summaryPath, source.messageRange[0], source.messageRange[1], source.timestamp, source.snippet);
  }

  private persistEntity(entity: EntityDocument): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO entities (dimension, name, description, created_at, last_updated)
      VALUES (?, ?, ?, ?, ?)
    `).run(entity.dimension, entity.name, entity.description, entity.createdAt, entity.lastUpdated);
  }

  private persistStoryEntity(storyId: string, dimension: Dimension, entityName: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO story_entities (story_id, dimension, entity_name)
      VALUES (?, ?, ?)
    `).run(storyId, dimension, entityName);
  }

  private persistProcessedSummary(path: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO processed_summaries (path) VALUES (?)
    `).run(path);
  }

  // ── Query Helpers ────────────────────────────────────────────────

  /** Get all stories from the index. */
  getAllStories(): StoryDocument[] {
    return [...this.index.documents.values()];
  }

  /** Get active stories sorted by last update. */
  getActiveStories(): StoryDocument[] {
    return this.getAllStories()
      .filter((e) => e.status === "active")
      .sort((a, b) => b.lastUpdated - a.lastUpdated);
  }

  /** Get distinct known values for each dimension. */
  getKnownDimensions(): { subjects: string[]; types: string[]; scenarios: string[] } {
    const subjects = new Set<string>();
    const types = new Set<string>();
    const scenarios = new Set<string>();
    for (const doc of this.index.documents.values()) {
      subjects.add(doc.attributes.subject);
      types.add(doc.attributes.type);
      scenarios.add(doc.attributes.scenario);
    }
    return {
      subjects: [...subjects],
      types: [...types],
      scenarios: [...scenarios],
    };
  }

  /** Get all stories for an entity. */
  getStoriesForEntity(dimension: Dimension, name: string): StoryDocument[] {
    const rows = this.db.prepare(`
      SELECT story_id FROM story_entities WHERE dimension = ? AND entity_name = ?
    `).all(dimension, name) as Array<{ story_id: string }>;

    const stories: StoryDocument[] = [];
    for (const row of rows) {
      const doc = this.index.documents.get(row.story_id);
      if (doc) stories.push(doc);
    }
    return stories;
  }

  /** Get an entity document. */
  getEntity(dimension: Dimension, name: string): EntityDocument | undefined {
    return this.index.entities.get(this.entityKey(dimension, name));
  }

  /** Check if a summary has already been processed. */
  isProcessed(summaryPath: string): boolean {
    return this.index.processedSummaries.has(summaryPath);
  }

  /** Get the raw index for engine state. */
  getIndex(): StoryIndex {
    return this.index;
  }

  /** No-op: DB lifecycle managed by MessageStore. */
  close(): void {}
}
