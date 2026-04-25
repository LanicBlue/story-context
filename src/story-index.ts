import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type {
  StoryDocument,
  EntityDocument,
  StoryIndex,
} from "./story-types.js";
import { StoryStorage } from "./story-storage.js";

type Dimension = "subject" | "type" | "scenario";

export class StoryIndexManager {
  private db: Database.Database;
  private readonly index: StoryIndex;

  constructor(
    db: Database.Database,
    private readonly storage: StoryStorage,
    private readonly sessionId: string,
  ) {
    this.db = db;
    this.index = {
      documents: new Map(),
      entities: new Map(),
    };
  }

  // ── Story ID Generation ──────────────────────────────────────────

  private generateStoryId(attrs: { subject: string; type: string; scenario: string }): string {
    const payload = [this.normalizeDim(attrs.subject), this.normalizeDim(attrs.type), this.normalizeDim(attrs.scenario)].join("|");
    const hash = createHash("sha256").update(payload).digest("hex").slice(0, 8);
    return `story-${hash}`;
  }

  private normalizeDim(val: string): string {
    return val.split(/[,，、]/)[0].trim().toLowerCase();
  }

  private entityKey(dimension: Dimension, name: string): string {
    return `${dimension}:${name}`;
  }

  // ── Entity Management ────────────────────────────────────────────

  private ensureEntitiesSync(
    attrs: { subject: string; type: string; scenario: string },
    storyId: string,
  ): void {
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
          createdAt: Date.now(),
          lastUpdated: Date.now(),
        };
        this.index.entities.set(key, entity);
        this.persistEntity(entity!);
      } else if (!entity.storyIds.includes(storyId)) {
        entity.storyIds.push(storyId);
        entity.lastUpdated = Date.now();
        this.persistEntity(entity);
      }

      this.persistStoryEntity(storyId, dim, name);
    }
  }

  // ── SQLite Persistence ───────────────────────────────────────────

  private persistStory(doc: StoryDocument): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO stories (id, title, subject, type, scenario, status, narrative, active_until_turn, last_edited_turn, created_at, last_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      doc.id, doc.title, doc.attributes.subject, doc.attributes.type,
      doc.attributes.scenario, doc.status, doc.narrative,
      doc.activeUntilTurn, doc.lastEditedTurn,
      doc.createdAt, doc.lastUpdated,
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

  // ── Query Helpers ────────────────────────────────────────────────

  /** Get all stories from the index. */
  getAllStories(): StoryDocument[] {
    return [...this.index.documents.values()];
  }

  /** Get active stories sorted by last update (most recent first). */
  getActiveStories(): StoryDocument[] {
    return this.getAllStories()
      .filter((e) => e.status === "active")
      .sort((a, b) => b.lastEditedTurn - a.lastEditedTurn);
  }

  /** Get stories that are active (activeUntilTurn >= currentTurn). */
  getActiveStoriesByTurn(currentTurn: number): StoryDocument[] {
    return this.getAllStories()
      .filter((e) => e.activeUntilTurn >= currentTurn && e.status === "active")
      .sort((a, b) => b.lastEditedTurn - a.lastEditedTurn);
  }

  /** Expire stories whose activeUntilTurn < currentTurn. */
  expireOldStories(currentTurn: number): void {
    for (const doc of this.index.documents.values()) {
      if (doc.activeUntilTurn > 0 && doc.activeUntilTurn < currentTurn) {
        doc.activeUntilTurn = 0;
        this.persistStory(doc);
      }
    }
  }

  /** Evict oldest active stories when count exceeds maxActiveStories. */
  evictOverflow(maxActiveStories: number, currentTurn: number): void {
    const active = this.getActiveStoriesByTurn(currentTurn);
    if (active.length <= maxActiveStories) return;
    // Evict oldest by lastEditedTurn (FIFO)
    const toEvict = active.slice(maxActiveStories);
    for (const doc of toEvict) {
      doc.activeUntilTurn = 0;
      this.persistStory(doc);
    }
  }

  // ── Direct Story Manipulation (for inner turn) ──────────────────

  /** Create a story directly from inner turn. Returns the story ID. */
  createStoryDirect(
    attrs: { subject: string; type: string; scenario: string; content: string },
    currentTurn: number,
    activeStoryTTL: number,
  ): string {
    const id = this.generateStoryId(attrs);
    const now = Date.now();
    const title = `${attrs.subject} — ${attrs.type}`;

    const doc: StoryDocument = {
      id,
      title,
      attributes: { subject: attrs.subject, type: attrs.type, scenario: attrs.scenario },
      sources: [],
      status: "active",
      narrative: attrs.content,
      activeUntilTurn: currentTurn + activeStoryTTL,
      lastEditedTurn: currentTurn,
      createdAt: now,
      lastUpdated: now,
    };

    this.index.documents.set(id, doc);
    this.persistStory(doc);
    this.ensureEntitiesSync(attrs, id);

    // Persist .md
    this.storage.writeStoryDocument(this.sessionId, doc).catch(() => {});

    return id;
  }

  /** Update story content directly from inner turn. */
  updateStoryContentDirect(
    storyId: string,
    content: string,
    append: boolean,
    currentTurn: number,
    activeStoryTTL: number,
  ): void {
    const doc = this.index.documents.get(storyId);
    if (!doc) throw new Error(`Story ${storyId} not found`);

    if (append) {
      doc.narrative += `\n\n${content}`;
    } else {
      doc.narrative = content;
    }
    doc.activeUntilTurn = currentTurn + activeStoryTTL;
    doc.lastEditedTurn = currentTurn;
    doc.lastUpdated = Date.now();

    this.persistStory(doc);

    // Persist .md
    this.storage.writeStoryDocument(this.sessionId, doc).catch(() => {});
  }

  removeStory(storyId: string): void {
    this.index.documents.delete(storyId);
    this.db.prepare("DELETE FROM stories WHERE id = ?").run(storyId);
    this.db.prepare("DELETE FROM stories_fts WHERE id = ?").run(storyId);
    this.db.prepare("DELETE FROM story_sources WHERE story_id = ?").run(storyId);
    this.db.prepare("DELETE FROM story_entities WHERE story_id = ?").run(storyId);
  }

  // ── Entity Queries ───────────────────────────────────────────────

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

  /** Get the raw index for engine state. */
  getIndex(): StoryIndex {
    return this.index;
  }

  // ── Bootstrap from SQLite ────────────────────────────────────────

  /** Rebuild in-memory index from persisted SQLite data. */
  loadFromDb(): void {
    // Stories
    const storyRows = this.db.prepare("SELECT * FROM stories").all() as Array<{
      id: string; title: string; subject: string; type: string; scenario: string;
      status: string; narrative: string; active_until_turn: number; last_edited_turn: number;
      created_at: number; last_updated: number;
    }>;
    for (const r of storyRows) {
      const sourceRows = this.db.prepare(
        "SELECT msg_start, msg_end, timestamp, snippet FROM story_sources WHERE story_id = ? ORDER BY timestamp"
      ).all(r.id) as Array<{
        msg_start: number; msg_end: number; timestamp: number; snippet: string;
      }>;
      this.index.documents.set(r.id, {
        id: r.id,
        title: r.title,
        attributes: { subject: r.subject, type: r.type, scenario: r.scenario },
        sources: sourceRows.map(s => ({
          messageRange: [s.msg_start, s.msg_end] as [number, number],
          timestamp: s.timestamp,
          snippet: s.snippet,
        })),
        status: r.status as StoryDocument["status"],
        narrative: r.narrative,
        activeUntilTurn: r.active_until_turn ?? 0,
        lastEditedTurn: r.last_edited_turn ?? 0,
        createdAt: r.created_at,
        lastUpdated: r.last_updated,
      });
    }

    // Entities
    const entityRows = this.db.prepare("SELECT * FROM entities").all() as Array<{
      dimension: string; name: string; description: string; created_at: number; last_updated: number;
    }>;
    for (const r of entityRows) {
      const seRows = this.db.prepare(
        "SELECT story_id FROM story_entities WHERE dimension = ? AND entity_name = ?"
      ).all(r.dimension, r.name) as Array<{ story_id: string }>;
      this.index.entities.set(this.entityKey(r.dimension as Dimension, r.name), {
        dimension: r.dimension as Dimension,
        name: r.name,
        description: r.description,
        storyIds: seRows.map(se => se.story_id),
        createdAt: r.created_at,
        lastUpdated: r.last_updated,
      });
    }
  }

  /** No-op: DB lifecycle managed by MessageStore. */
  close(): void {}
}
