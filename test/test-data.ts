/**
 * Shared test constants and factory functions.
 */

import { vi } from "vitest";
import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import type { StoryDocument } from "../src/story-types.js";
import type { Summarizer } from "../src/types.js";

// ── Dimension Values ──────────────────────────────────────────────

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

export const SUBJECTS = {
  opinionAnalysis: "opinion-analysis",
  authModule: "auth-module",
  crawlerPipeline: "crawler-pipeline",
} as const;

// ── DB Schema ────────────────────────────────────────────────────

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

// ── Mock Summarizer Factory ──────────────────────────────────────

export function makeMockSummarizer(responses: string[]): Summarizer {
  let callIdx = 0;
  return {
    rawGenerate: vi.fn(async () => {
      const resp = responses[callIdx] ?? '{"actions":[]}';
      callIdx++;
      return resp;
    }),
  };
}

export function makeFailingMockSummarizer(): Summarizer {
  return {
    rawGenerate: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
  };
}

// ── Session ID ───────────────────────────────────────────────────

export const SID = "test-session";

// ── Integration Test: Data Source ─────────────────────────────────

export const TEST_DB_PATH = join(import.meta.dirname, "..", "data", "lcm.db");

export const JSONL_FILES = [
  join(import.meta.dirname, "..", "data", "06bc5eef-dc76-45d8-8ad7-af34816fe5f7.jsonl.reset.2026-04-06T20-12-53.300Z"),
  join(import.meta.dirname, "..", "data", "a4572a02-3a86-446c-b98c-0a0e25cbf4af.jsonl.reset.2026-03-23T23-10-01.829Z"),
];

export const TEST_OUTPUT_DIR = join(import.meta.dirname, "..", "data", "test-output");
export const LLM_TEST_OUTPUT_DIR = join(import.meta.dirname, "..", "data", "llm-test-output");

export type LoadedConversation = {
  messages: Array<Record<string, unknown>>;
  totalTokens: number;
  totalCount: number;
};

/** Load a conversation from SQLite DB. */
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

// ── JSONL Loader ─────────────────────────────────────────────────

function jsonlExtractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: any) => {
      if (typeof b === "string") return b;
      if (b && b.type === "thinking") return "";
      return b.text ?? b.content ?? "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

type ContentBlock = { type: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> };

function normalizeContent(content: unknown): ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.map((b: any) => {
    if (typeof b === "string") return { type: "text", text: b };
    if (b && typeof b === "object") {
      return {
        type: b.type ?? "unknown",
        text: typeof b.text === "string" ? b.text : undefined,
        id: typeof b.id === "string" ? b.id : undefined,
        name: typeof b.name === "string" ? b.name : undefined,
        arguments: b.arguments && typeof b.arguments === "object" ? b.arguments as Record<string, unknown> : undefined,
      };
    }
    return { type: "unknown" };
  });
}

export function loadJsonlConversation(
  fileIndex: number,
  opts?: { limit?: number; offset?: number },
): LoadedConversation {
  const filePath = JSONL_FILES[fileIndex];
  const raw = readFileSync(filePath, "utf-8");

  type JsonlMessage = { role: string; content: unknown; toolCallId?: string; toolName?: string; isError?: boolean; timestamp?: number };
  type JsonlEntry = { type: string; message?: JsonlMessage };

  const allMessages: Array<Record<string, unknown>> = [];
  for (const line of raw.split("\n").filter(Boolean)) {
    let entry: JsonlEntry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== "message" || !entry.message) continue;
    const msg = entry.message;

    if (msg.role === "user") {
      const text = jsonlExtractText(msg.content);
      if (text) allMessages.push({ role: "user", content: text, timestamp: msg.timestamp ?? Date.now() });

    } else if (msg.role === "assistant") {
      const blocks = normalizeContent(msg.content);
      const textParts: string[] = [];
      const toolCalls: Array<Record<string, unknown>> = [];
      for (const b of blocks) {
        if (b.type === "toolCall") {
          toolCalls.push({ type: "toolCall", id: b.id, name: b.name, arguments: b.arguments });
        } else if (b.text) {
          textParts.push(b.text);
        }
      }
      const text = textParts.join("\n").trim();
      if (text) allMessages.push({ role: "assistant", content: text, timestamp: msg.timestamp ?? Date.now() });
      for (const tc of toolCalls) {
        allMessages.push({ role: "assistant", content: "", toolCalls: [tc], timestamp: msg.timestamp ?? Date.now() });
      }

    } else if (msg.role === "toolResult") {
      const text = jsonlExtractText(msg.content);
      if (text) {
        allMessages.push({ role: "toolResult", content: text, toolName: msg.toolName ?? "unknown", args: {}, timestamp: msg.timestamp ?? Date.now() });
      }
    }
  }

  const offset = opts?.offset ?? 0;
  const limit = opts?.limit;
  const sliced = limit ? allMessages.slice(offset, offset + limit) : allMessages.slice(offset);
  const totalTokens = sliced.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length / 4 : 0), 0);

  return { messages: sliced, totalTokens: Math.round(totalTokens), totalCount: allMessages.length };
}

export function printTree(dir: string, prefix = "", depth = 0): void {
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
