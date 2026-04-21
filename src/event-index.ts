import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  EventSummary,
  EventDocument,
  EntityDocument,
  EventIndex,
} from "./event-types.js";
import { EventStorage } from "./event-storage.js";
import type { Summarizer } from "./types.js";

type Dimension = "subject" | "type" | "scenario";

export class EventIndexManager {
  private db: Database.Database;
  private readonly index: EventIndex;

  constructor(
    dbPath: string,
    private readonly storage: EventStorage,
    private readonly sessionId: string,
    private readonly summarizer?: Summarizer,
  ) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
    this.index = {
      documents: new Map(),
      entities: new Map(),
      processedSummaries: new Set(),
    };
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
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

      CREATE TABLE IF NOT EXISTS event_sources (
        event_id TEXT NOT NULL,
        summary_path TEXT NOT NULL,
        msg_start INTEGER NOT NULL,
        msg_end INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        snippet TEXT DEFAULT '',
        FOREIGN KEY (event_id) REFERENCES events(id)
      );

      CREATE TABLE IF NOT EXISTS entities (
        dimension TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        created_at INTEGER NOT NULL,
        last_updated INTEGER NOT NULL,
        PRIMARY KEY (dimension, name)
      );

      CREATE TABLE IF NOT EXISTS event_entities (
        event_id TEXT NOT NULL,
        dimension TEXT NOT NULL,
        entity_name TEXT NOT NULL,
        PRIMARY KEY (event_id, dimension)
      );

      CREATE TABLE IF NOT EXISTS processed_summaries (
        path TEXT PRIMARY KEY
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(id, title, subject, type, scenario, narrative);
    `);
  }

  // ── Event ID Generation ──────────────────────────────────────────

  private generateEventId(attrs: { subject: string; type: string; scenario: string }): string {
    const payload = [attrs.subject, attrs.type, attrs.scenario].join("|");
    const hash = createHash("sha256").update(payload).digest("hex").slice(0, 8);
    return `evt-${hash}`;
  }

  private entityKey(dimension: Dimension, name: string): string {
    return `${dimension}:${name}`;
  }

  // ── Process Event Summaries ──────────────────────────────────────

  /** Process extracted event summaries: match, create/update events, update entities. */
  async processSummaries(summaries: EventSummary[]): Promise<void> {
    for (const summary of summaries) {
      const match = await this.findMatch(summary);

      if (match) {
        await this.updateEvent(match, summary);
      } else {
        await this.createEvent(summary);
      }
    }
  }

  /** Find an existing event that matches all three dimensions semantically. */
  private async findMatch(summary: EventSummary): Promise<EventDocument | undefined> {
    const candidates = this.searchCandidates(summary.attributes);

    if (candidates.length === 0) return undefined;

    // If we have an LLM, use semantic matching
    if (this.summarizer) {
      for (const candidate of candidates) {
        const isMatch = await this.semanticMatch(
          candidate.attributes,
          summary.attributes,
        );
        if (isMatch) return candidate;
      }
      return undefined;
    }

    // Fallback: exact match on all three dimensions
    for (const candidate of candidates) {
      if (
        candidate.attributes.subject === summary.attributes.subject &&
        candidate.attributes.type === summary.attributes.type &&
        candidate.attributes.scenario === summary.attributes.scenario
      ) {
        return candidate;
      }
    }
    return undefined;
  }

  private searchCandidates(attrs: { subject: string; type: string; scenario: string }): EventDocument[] {
    // Try FTS5 first for broad match
    const rows = this.db.prepare(`
      SELECT id FROM events_fts WHERE events_fts MATCH ? LIMIT 20
    `).all(`${attrs.subject} ${attrs.type} ${attrs.scenario}`) as Array<{ id: string }>;

    const results: EventDocument[] = [];
    for (const row of rows) {
      const doc = this.index.documents.get(row.id);
      if (doc) results.push(doc);
    }

    // If FTS returns nothing, scan in-memory index
    if (results.length === 0) {
      for (const doc of this.index.documents.values()) {
        if (
          doc.attributes.subject === attrs.subject ||
          doc.attributes.type === attrs.type ||
          doc.attributes.scenario === attrs.scenario
        ) {
          results.push(doc);
        }
      }
    }

    return results;
  }

  private async semanticMatch(
    existing: { subject: string; type: string; scenario: string },
    incoming: { subject: string; type: string; scenario: string },
  ): Promise<boolean> {
    if (!this.summarizer) return false;

    try {
      const prompt = `Determine whether the attributes of these two events semantically match. Values expressing the same concept with different wording also count as matching.
Event A: subject="${existing.subject}", type="${existing.type}", scenario="${existing.scenario}"
Event B: subject="${incoming.subject}", type="${incoming.type}", scenario="${incoming.scenario}"
Output JSON only: {"subject": true/false, "type": true/false, "scenario": true/false}`;

      const response = await this.summarizer.summarize(prompt, 100);
      const parsed = JSON.parse(response);
      return parsed.subject === true && parsed.type === true && parsed.scenario === true;
    } catch {
      // Fallback to exact match
      return (
        existing.subject === incoming.subject &&
        existing.type === incoming.type &&
        existing.scenario === incoming.scenario
      );
    }
  }

  // ── Create / Update Events ───────────────────────────────────────

  private async createEvent(summary: EventSummary): Promise<void> {
    const id = this.generateEventId(summary.attributes);
    const now = Date.now();
    const title = `${summary.attributes.subject} — ${summary.attributes.type}`;

    const doc: EventDocument = {
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
    this.persistEvent(doc);
    this.persistEventSource(id, doc.sources[0]);
    this.persistProcessedSummary(summary.sourceSummary);

    // Ensure entities exist and link
    await this.ensureEntities(summary.attributes, id);

    // Persist .md
    await this.storage.writeEventDocument(this.sessionId, doc);
  }

  private async updateEvent(doc: EventDocument, summary: EventSummary): Promise<void> {
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
    this.persistEvent(doc);
    this.persistEventSource(doc.id, doc.sources[doc.sources.length - 1]);
    this.persistProcessedSummary(summary.sourceSummary);

    // Persist .md
    await this.storage.writeEventDocument(this.sessionId, doc);
  }

  // ── Entity Management ────────────────────────────────────────────

  private async ensureEntities(
    attrs: { subject: string; type: string; scenario: string },
    eventId: string,
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
          eventIds: [eventId],
          relatedEntities: [],
          createdAt: Date.now(),
          lastUpdated: Date.now(),
        };
        this.index.entities.set(key, entity);
        this.persistEntity(entity);
      } else if (!entity.eventIds.includes(eventId)) {
        entity.eventIds.push(eventId);
        entity.lastUpdated = Date.now();
        this.persistEntity(entity);
      }

      // Link event to entity
      this.persistEventEntity(eventId, dim, name);

      // Persist .md
      await this.storage.writeEntityDocument(this.sessionId, entity);
    }
  }

  // ── SQLite Persistence ───────────────────────────────────────────

  private persistEvent(doc: EventDocument): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO events (id, title, subject, type, scenario, status, narrative, created_at, last_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      doc.id, doc.title, doc.attributes.subject, doc.attributes.type,
      doc.attributes.scenario, doc.status, doc.narrative, doc.createdAt, doc.lastUpdated,
    );

    // Update FTS
    this.db.prepare(`
      INSERT OR REPLACE INTO events_fts (id, title, subject, type, scenario, narrative)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      doc.id, doc.title, doc.attributes.subject, doc.attributes.type,
      doc.attributes.scenario, doc.narrative,
    );
  }

  private persistEventSource(eventId: string, source: EventDocument["sources"][0]): void {
    this.db.prepare(`
      INSERT INTO event_sources (event_id, summary_path, msg_start, msg_end, timestamp, snippet)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(eventId, source.summaryPath, source.messageRange[0], source.messageRange[1], source.timestamp, source.snippet);
  }

  private persistEntity(entity: EntityDocument): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO entities (dimension, name, description, created_at, last_updated)
      VALUES (?, ?, ?, ?, ?)
    `).run(entity.dimension, entity.name, entity.description, entity.createdAt, entity.lastUpdated);
  }

  private persistEventEntity(eventId: string, dimension: Dimension, entityName: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO event_entities (event_id, dimension, entity_name)
      VALUES (?, ?, ?)
    `).run(eventId, dimension, entityName);
  }

  private persistProcessedSummary(path: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO processed_summaries (path) VALUES (?)
    `).run(path);
  }

  // ── Query Helpers ────────────────────────────────────────────────

  /** Get all events from the index. */
  getAllEvents(): EventDocument[] {
    return [...this.index.documents.values()];
  }

  /** Get active events sorted by last update. */
  getActiveEvents(): EventDocument[] {
    return this.getAllEvents()
      .filter((e) => e.status === "active")
      .sort((a, b) => b.lastUpdated - a.lastUpdated);
  }

  /** Get all events for an entity. */
  getEventsForEntity(dimension: Dimension, name: string): EventDocument[] {
    const rows = this.db.prepare(`
      SELECT event_id FROM event_entities WHERE dimension = ? AND entity_name = ?
    `).all(dimension, name) as Array<{ event_id: string }>;

    const events: EventDocument[] = [];
    for (const row of rows) {
      const doc = this.index.documents.get(row.event_id);
      if (doc) events.push(doc);
    }
    return events;
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
  getIndex(): EventIndex {
    return this.index;
  }

  /** Close the database. */
  close(): void {
    this.db.close();
  }
}
