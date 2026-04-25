import Database from "better-sqlite3";
import { mkdirSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import type { SessionState } from "./types.js";

// ── Schema ────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  seq   INTEGER PRIMARY KEY,
  role  TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  meta  TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stories (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  subject TEXT NOT NULL,
  type TEXT NOT NULL,
  scenario TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  narrative TEXT DEFAULT '',
  active_until_turn INTEGER NOT NULL DEFAULT 0,
  last_edited_turn INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS story_sources (
  story_id TEXT NOT NULL,
  msg_start INTEGER NOT NULL,
  msg_end INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  snippet TEXT DEFAULT '',
  FOREIGN KEY (story_id) REFERENCES stories(id)
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

CREATE VIRTUAL TABLE IF NOT EXISTS stories_fts USING fts5(id, title, subject, type, scenario, narrative);
`;

const MIGRATIONS = `
ALTER TABLE stories ADD COLUMN active_until_turn INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stories ADD COLUMN last_edited_turn INTEGER NOT NULL DEFAULT 0;
`;

type MessageRow = {
  seq: number;
  role: string;
  content: string;
  meta: string;
};

// ── MessageStore ──────────────────────────────────────────────────

export class MessageStore {
  private readonly baseDir: string;
  private readonly dbs = new Map<string, Database.Database>();

  constructor(baseDir: string) {
    this.baseDir = baseDir || join(tmpdir(), "story-context");
  }

  /** Get or create the shared DB connection for a session. */
  getDb(sessionId: string): Database.Database {
    let db = this.dbs.get(sessionId);
    if (!db) {
      const dir = join(this.baseDir, sessionId);
      mkdirSync(dir, { recursive: true });
      // Migrate old state.db → session.db
      const oldPath = join(dir, "state.db");
      const newPath = join(dir, "session.db");
      if (!existsSync(newPath) && existsSync(oldPath)) {
        renameSync(oldPath, newPath);
      }
      db = new Database(newPath);
      db.pragma("journal_mode = WAL");
      db.exec(SCHEMA);
      // Apply migrations (ignore errors if column already exists)
      for (const line of MIGRATIONS.trim().split(";")) {
        const sql = line.trim();
        if (sql) {
          try { db.exec(sql); } catch { /* column already exists */ }
        }
      }
      this.dbs.set(sessionId, db);
    }
    return db;
  }

  // ── Message writes ──────────────────────────────────────────────

  /** Insert or update a message (called from afterTurn). */
  upsertMessage(sessionId: string, seq: number, msg: unknown): void {
    const db = this.getDb(sessionId);
    const m = msg as Record<string, unknown>;
    const meta = extractMeta(m);
    db.prepare(
      "INSERT OR REPLACE INTO messages (seq, role, content, meta) VALUES (?, ?, ?, ?)",
    ).run(seq, m.role ?? "unknown", typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""), JSON.stringify(meta));
  }

  // ── State writes ────────────────────────────────────────────────

  saveState(sessionId: string, state: SessionState): void {
    const db = this.getDb(sessionId);
    const upsert = db.prepare(
      "INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)",
    );
    db.transaction(() => {
      upsert.run("lastProcessedIdx", String(state.lastProcessedIdx));
      upsert.run("activeStories", JSON.stringify(state.activeStories));
      upsert.run("seenReads", JSON.stringify([...state.seenReads.entries()]));
      upsert.run("adjustedMessageWindowSize", state.adjustedMessageWindowSize != null ? String(state.adjustedMessageWindowSize) : "");
      upsert.run("adjustedMaxActiveStories", state.adjustedMaxActiveStories != null ? String(state.adjustedMaxActiveStories) : "");
      upsert.run("version", "2");
    })();
  }

  // ── Load ────────────────────────────────────────────────────────

  /** Load full session state from DB. Returns null if no saved state. */
  load(sessionId: string): SessionState | null {
    const dir = join(this.baseDir, sessionId);
    const newPath = join(dir, "session.db");
    const oldPath = join(dir, "state.db");

    let dbPath: string;
    if (existsSync(newPath)) {
      dbPath = newPath;
    } else if (existsSync(oldPath)) {
      dbPath = oldPath;
    } else {
      return null;
    }

    let db: Database.Database;
    try {
      db = new Database(dbPath, { readonly: true });
    } catch {
      return null;
    }

    try {
      const version = db.prepare("SELECT value FROM state WHERE key = 'version'").get() as { value: string } | undefined;
      if (!version) return null;

      // Messages
      const rows = db.prepare("SELECT * FROM messages ORDER BY seq").all() as MessageRow[];
      const messages: unknown[] = rows.map((r) => {
        const meta = parseMeta(r.meta);
        return {
          role: r.role,
          content: r.content,
          ...meta,
        };
      });

      // Runtime state
      const get = (key: string): string | null =>
        (db.prepare("SELECT value FROM state WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;

      const seenReadsArr = JSON.parse(get("seenReads") || "[]") as Array<[string, number]>;
      const adjMsgWindow = get("adjustedMessageWindowSize");
      const adjMaxStories = get("adjustedMaxActiveStories");

      return {
        messages,
        lastProcessedIdx: parseInt(get("lastProcessedIdx") || "0", 10),
        seenReads: new Map(seenReadsArr),
        activeStories: JSON.parse(get("activeStories") || "[]"),
        currentTurn: parseInt(get("currentTurn") || "0", 10),
        turnsSinceInnerTurn: parseInt(get("turnsSinceInnerTurn") || "0", 10),
        innerTurnRunning: false,
        adjustedMessageWindowSize: adjMsgWindow ? parseInt(adjMsgWindow, 10) : undefined,
        adjustedMaxActiveStories: adjMaxStories ? parseInt(adjMaxStories, 10) : undefined,
      };
    } finally {
      db.close();
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  /** Close all open DBs. */
  closeAll(): void {
    for (const db of this.dbs.values()) db.close();
    this.dbs.clear();
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function extractMeta(m: Record<string, unknown>): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (m.toolName !== undefined) meta.toolName = m.toolName;
  if (m.args !== undefined) meta.args = m.args;
  if (m.toolCallId !== undefined) meta.toolCallId = m.toolCallId;
  if (m.isError !== undefined) meta.isError = m.isError;
  if (m._dropped !== undefined) meta._dropped = m._dropped;
  if (m.timestamp !== undefined) meta.timestamp = m.timestamp;
  return meta;
}

function parseMeta(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
