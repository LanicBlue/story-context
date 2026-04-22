import Database from "better-sqlite3";
import { createHash } from "node:crypto";
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
    db: Database.Database,
    private readonly storage: EventStorage,
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
      const match = this.findMatch(summary);

      if (match) {
        await this.updateEvent(match, summary);
      } else {
        await this.createEvent(summary);
      }
    }
  }

  /** Find an existing event that matches all three dimensions exactly. */
  private findMatch(summary: EventSummary): EventDocument | undefined {
    for (const doc of this.index.documents.values()) {
      if (
        doc.attributes.subject === summary.attributes.subject &&
        doc.attributes.type === summary.attributes.type &&
        doc.attributes.scenario === summary.attributes.scenario
      ) {
        return doc;
      }
    }
    return undefined;
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

  /** No-op: DB lifecycle managed by MessageStore. */
  close(): void {}
}
