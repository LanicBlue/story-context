/**
 * Shared test constants and factory functions.
 * Change dimension values here to propagate across all test files.
 */

import { vi } from "vitest";
import { join } from "node:path";
import type { StoryDocument, StorySummary } from "../src/story-types.js";
import type { Summarizer } from "../src/types.js";

// ── Dimension Values (single source of truth) ────────────────────

export const TYPES = {
  implementation: "implementation",
  debugging: "debugging",
  exploration: "exploration",
  assistance: "assistance",
  analysis: "analysis",
  testing: "testing",
  design: "design",
} as const;

export const SCENARIOS = {
  softwareCoding: "software.coding",
  softwareTesting: "software.testing",
  softwareDevops: "software.devops",
  softwareArchitecture: "software.architecture",
  dataCrawling: "data.crawling",
  dataEngineering: "data.engineering",
  dataAnalytics: "data.analytics",
  systemOps: "system.ops",
  systemAutomation: "system.automation",
  contentWriting: "content.writing",
  contentDesign: "content.design",
  contentMedia: "content.media",
  mediaPublicOpinion: "media.public-opinion",
  researchKnowledge: "research.knowledge",
  general: "general",
} as const;

// ── Subject values ───────────────────────────────────────────────

export const SUBJECTS = {
  opinionAnalysis: "opinion-analysis",
  authModule: "auth-module",
  crawlerPipeline: "crawler-pipeline",
} as const;

// ── DB Schema (for tests that create their own DB) ────────────────

export const TEST_DB_SCHEMA = `
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

// ── Message Factory ──────────────────────────────────────────────

export function makeMessage(
  role: "user" | "assistant" | "toolResult",
  content: string,
  extra?: Record<string, unknown>,
) {
  return { role, content, timestamp: Date.now(), ...extra };
}

export function makeToolResult(
  toolName: string,
  content: string,
  args?: Record<string, unknown>,
) {
  return makeMessage("toolResult", content, {
    toolName,
    args: args ?? {},
  });
}

// ── Story Factory ────────────────────────────────────────────────

export function makeStoryDoc(overrides: Partial<StoryDocument> = {}): StoryDocument {
  return {
    id: "story-test1234",
    title: `${SUBJECTS.authModule} — ${TYPES.debugging}`,
    attributes: {
      subject: SUBJECTS.authModule,
      type: TYPES.debugging,
      scenario: SCENARIOS.softwareCoding,
    },
    sources: [],
    status: "active",
    narrative: "Fixed a bug in the auth module.",
    activeUntilTurn: 0,
    lastEditedTurn: 0,
    createdAt: Date.now(),
    lastUpdated: Date.now(),
    ...overrides,
  };
}

export function makeStorySummary(overrides: Partial<StorySummary> = {}): StorySummary {
  return {
    content: "Built auth module with JWT support.",
    attributes: {
      subject: SUBJECTS.authModule,
      type: TYPES.implementation,
      scenario: SCENARIOS.softwareCoding,
    },
    sourceSummary: "summaries/2026-04-21-0.md",
    messageRange: [0, 5],
    timestamp: Date.now(),
    ...overrides,
  };
}

// ── Mock Summarizer Factory ──────────────────────────────────────

export function makeMockSummarizer(responses: string[]): Summarizer {
  let callIdx = 0;
  return {
    summarize: vi.fn().mockResolvedValue(""),
    rawGenerate: vi.fn(async () => {
      const resp = responses[callIdx] ?? '{"actions":[]}';
      callIdx++;
      return resp;
    }),
  };
}

export function makeFailingMockSummarizer(): Summarizer {
  return {
    summarize: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
    rawGenerate: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
  };
}

export function makeStructuralMockSummarizer(): Summarizer {
  return {
    summarize: vi.fn().mockResolvedValue("# Compressed Summary\n## Task Intent\n- Test task\n## Conclusion\n- Done"),
    rawGenerate: vi.fn().mockResolvedValue("[]"),
  };
}

// ── Session ID ───────────────────────────────────────────────────

export const SID = "test-session";

// ── Integration Test: Data Source ─────────────────────────────────

/** DB path — change this to switch test data source */
export const TEST_DB_PATH = join(import.meta.dirname, "..", "data", "lcm.db");

/** Output dirs — change these to redirect test output */
export const TEST_OUTPUT_DIR = join(import.meta.dirname, "..", "data", "test-output");
export const LLM_TEST_OUTPUT_DIR = join(import.meta.dirname, "..", "data", "llm-test-output");

export type LoadedConversation = {
  messages: Array<Record<string, unknown>>;
  totalTokens: number;
  totalCount: number;
};

/** Load a conversation from SQLite DB and map to engine message format. */
export async function loadConversation(convId: number, opts?: { limit?: number; offset?: number }): Promise<LoadedConversation> {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });

  const limit = opts?.limit;
  const offset = opts?.offset ?? 0;

  let sql = `SELECT message_id, seq, role, content, token_count
       FROM messages
       WHERE conversation_id = ?
       ORDER BY seq`;
  const params: Array<number> = [convId];
  if (limit) {
    sql += ` LIMIT ? OFFSET ?`;
    params.push(limit, offset);
  }

  const messages = db.prepare(sql).all(...params) as Array<{
    message_id: number;
    seq: number;
    role: string;
    content: string;
    token_count: number;
  }>;

  const totalCount = (
    db
      .prepare("SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?")
      .get(convId) as { c: number }
  ).c;
  const totalTokens = (
    db
      .prepare("SELECT SUM(token_count) as t FROM messages WHERE conversation_id = ?")
      .get(convId) as { t: number | null }
  ).t ?? 0;

  const msgIds = messages.map((m) => m.message_id);
  const toolParts = new Map<
    number,
    Array<{ tool_name: string; tool_input: string; tool_output: string }>
  >();

  if (msgIds.length > 0) {
    const placeholders = msgIds.map(() => "?").join(",");
    const partRows = db
      .prepare(
        `SELECT message_id, tool_name, tool_input, tool_output
         FROM message_parts
         WHERE part_type = 'tool' AND message_id IN (${placeholders})`,
      )
      .all(...msgIds) as Array<{
      message_id: number;
      tool_name: string;
      tool_input: string;
      tool_output: string;
    }>;

    for (const p of partRows) {
      if (!toolParts.has(p.message_id)) toolParts.set(p.message_id, []);
      toolParts.get(p.message_id)!.push(p);
    }
  }

  db.close();

  const result: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    if (msg.role === "tool") {
      const parts = toolParts.get(msg.message_id) ?? [];
      if (parts.length > 0) {
        for (const part of parts) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(part.tool_input || "{}"); } catch { /* ignore */ }
          result.push({
            role: "toolResult",
            content: msg.content || part.tool_output || "",
            toolName: part.tool_name,
            args,
            timestamp: Date.now(),
          });
        }
      } else {
        result.push({
          role: "toolResult",
          content: msg.content || "",
          toolName: "unknown",
          args: {},
          timestamp: Date.now(),
        });
      }
    } else {
      result.push({
        role: msg.role as "user" | "assistant",
        content: msg.content || "",
        timestamp: Date.now(),
      });
    }
  }

  return { messages: result, totalTokens, totalCount };
}

/** Print directory tree for test output inspection. */
export function printTree(dir: string, prefix = "", depth = 0): void {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  if (depth > 3) return;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries.slice(0, 30)) {
    console.log(`${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`);
    if (entry.isDirectory()) {
      printTree(join(dir, entry.name), prefix + "  ", depth + 1);
    }
  }
  if (entries.length > 30) {
    console.log(`${prefix}... (${entries.length - 30} more)`);
  }
}
