import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { EventDocument, EntityDocument } from "./event-types.js";
import { ContentStorage } from "./content-storage.js";

// ── YAML Frontmatter Parse/Serialize ──────────────────────────────

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx !== -1) {
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return { meta, body: match[2] };
}

function serializeFrontmatter(meta: Record<string, string>, body: string): string {
  const lines = Object.entries(meta)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${lines}\n---\n${body}`;
}

// ── Event Storage ──────────────────────────────────────────────────

export class EventStorage {
  constructor(private readonly storage: ContentStorage) {}

  // ── Summary files ──────────────────────────────────────────────

  /** Generate the next summary filename for today: summaries/YYYY-MM-DD-N.md */
  async nextSummaryName(sessionId: string): Promise<string> {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const dir = this.storage.resolvePath(sessionId, "summaries");
    let maxN = -1;
    try {
      const files = await readdir(dir);
      for (const f of files) {
        const m = f.match(/^(\d{4}-\d{2}-\d{2})-(\d+)\.md$/);
        if (m && m[1] === today) {
          maxN = Math.max(maxN, Number.parseInt(m[2], 10));
        }
      }
    } catch { /* dir doesn't exist yet */ }
    return `summaries/${today}-${maxN + 1}.md`;
  }

  /** Write a summary file. */
  async writeSummary(sessionId: string, relPath: string, markdown: string): Promise<void> {
    const absPath = this.storage.resolvePath(sessionId, relPath);
    await mkdir(join(absPath, ".."), { recursive: true });
    await writeFile(absPath, markdown, "utf-8");
  }

  // ── Event documents ────────────────────────────────────────────

  /** Write an event document to events/{id}.md */
  async writeEventDocument(sessionId: string, doc: EventDocument): Promise<void> {
    const meta: Record<string, string> = {
      id: doc.id,
      status: doc.status,
      created: new Date(doc.createdAt).toISOString(),
      lastUpdated: new Date(doc.lastUpdated).toISOString(),
    };

    const subject = doc.attributes.subject;
    const type = doc.attributes.type;
    const scenario = doc.attributes.scenario;

    const body = [
      `# ${doc.title}\n`,
      `## Attributes\n`,
      `- **Subject**: [[subject:${subject}]]`,
      `- **Type**: [[type:${type}]]`,
      `- **Scenario**: [[scenario:${scenario}]]\n`,
      `## Narrative\n`,
      doc.narrative + "\n",
      `## Sources\n`,
      "| # | Summary | Messages | Time | Snippet |",
      "|---|---------|----------|------|---------|",
      ...doc.sources.map(
        (s, i) =>
          `| ${i + 1} | [[${s.summaryPath.replace(/\.md$/, "")}]] | ${s.messageRange[0]} - ${s.messageRange[1]} | ${new Date(s.timestamp).toISOString().slice(0, 16)} | ${escapeTable(s.snippet.slice(0, 60))} |`,
      ),
    ].join("\n");

    const content = serializeFrontmatter(meta, body);
    const absPath = this.storage.resolvePath(sessionId, `events/${doc.id}.md`);
    await mkdir(join(absPath, ".."), { recursive: true });
    await writeFile(absPath, content, "utf-8");
  }

  /** Read an event document from disk. */
  async readEventDocument(sessionId: string, eventId: string): Promise<EventDocument | undefined> {
    try {
      const absPath = this.storage.resolvePath(sessionId, `events/${eventId}.md`);
      const raw = await readFile(absPath, "utf-8");
      return parseEventDocument(raw);
    } catch {
      return undefined;
    }
  }

  // ── Entity documents ───────────────────────────────────────────

  /** Write an entity document to subjects/|types/|scenarios/{name}.md */
  async writeEntityDocument(sessionId: string, doc: EntityDocument): Promise<void> {
    const meta: Record<string, string> = {
      dimension: doc.dimension,
      name: doc.name,
      created: new Date(doc.createdAt).toISOString(),
      lastUpdated: new Date(doc.lastUpdated).toISOString(),
    };

    const dimLabel = { subject: "Subject", type: "Type", scenario: "Scenario" }[doc.dimension];

    const body = [
      `# ${doc.name}\n`,
      `## Description\n`,
      doc.description + "\n",
      `## Events\n`,
      ...doc.eventIds.map((eid) => `- [[${eid}]]`),
      doc.eventIds.length === 0 ? "- (none)" : "",
      `\n## Related Entities\n`,
      ...doc.relatedEntities.map(
        (re) => `- [[${re.dimension}:${re.name}]]`,
      ),
      doc.relatedEntities.length === 0 ? "- (none)" : "",
    ].join("\n");

    const content = serializeFrontmatter(meta, body);
    const dir = `${doc.dimension}s`; // subjects/ types/ scenarios/
    const absPath = this.storage.resolvePath(sessionId, `${dir}/${doc.name}.md`);
    await mkdir(join(absPath, ".."), { recursive: true });
    await writeFile(absPath, content, "utf-8");
  }

  /** Read an entity document from disk. */
  async readEntityDocument(
    sessionId: string,
    dimension: "subject" | "type" | "scenario",
    name: string,
  ): Promise<EntityDocument | undefined> {
    try {
      const dir = `${dimension}s`;
      const absPath = this.storage.resolvePath(sessionId, `${dir}/${name}.md`);
      const raw = await readFile(absPath, "utf-8");
      return parseEntityDocument(raw);
    } catch {
      return undefined;
    }
  }

  /** List all event IDs on disk. */
  async listEventIds(sessionId: string): Promise<string[]> {
    try {
      const dir = this.storage.resolvePath(sessionId, "events");
      const files = await readdir(dir);
      return files
        .filter((f) => f.startsWith("evt-") && f.endsWith(".md"))
        .map((f) => f.replace(/\.md$/, ""));
    } catch {
      return [];
    }
  }
}

// ── Parse helpers ──────────────────────────────────────────────────

function parseEventDocument(raw: string): EventDocument {
  const { meta, body } = parseFrontmatter(raw);

  // Extract attributes from wiki links in the body
  const subjectMatch = body.match(/\[\[subject:([^\]]+)\]\]/);
  const typeMatch = body.match(/\[\[type:([^\]]+)\]\]/);
  const scenarioMatch = body.match(/\[\[scenario:([^\]]+)\]\]/);

  // Extract sources from table rows
  const sources: EventDocument["sources"] = [];
  const sourceRows = body.matchAll(/\|\s*(\d+)\s*\|\s*\[\[([^\]]+)\]\]\s*\|\s*(\d+)\s*-\s*(\d+)\s*\|\s*([^\|]*)\|\s*([^\|]*)\|/g);
  for (const m of sourceRows) {
    sources.push({
      summaryPath: m[2] + ".md",
      messageRange: [Number(m[3]), Number(m[4])],
      timestamp: Date.parse(m[5].trim()) || Date.now(),
      snippet: m[6].trim(),
    });
  }

  // Extract narrative
  const narrativeMatch = body.match(/## Narrative\s*\n([\s\S]*?)(?=\n## |\n$)/);
  const titleMatch = body.match(/^#\s+(.+)$/m);

  return {
    id: meta.id || "",
    title: titleMatch?.[1] || meta.id || "",
    attributes: {
      subject: subjectMatch?.[1] || "未知",
      type: typeMatch?.[1] || "对话",
      scenario: scenarioMatch?.[1] || "通用",
    },
    sources,
    status: (meta.status as EventDocument["status"]) || "active",
    narrative: narrativeMatch?.[1]?.trim() || "",
    createdAt: meta.created ? Date.parse(meta.created) : Date.now(),
    lastUpdated: meta.lastUpdated ? Date.parse(meta.lastUpdated) : Date.now(),
  };
}

function parseEntityDocument(raw: string): EntityDocument {
  const { meta, body } = parseFrontmatter(raw);

  // Extract event IDs from [[evt-xxx]] links
  const eventIds = [...body.matchAll(/\[\[(evt-[^\]]+)\]\]/g)].map((m) => m[1]);

  // Extract description
  const descMatch = body.match(/## Description\s*\n([\s\S]*?)(?=\n## )/);
  const desc = descMatch?.[1]?.trim() || "";

  // Extract related entities
  const relatedEntities: EntityDocument["relatedEntities"] = [];
  const relMatches = body.matchAll(/\[\[(subject|type|scenario):([^\]]+)\]\]/g);
  for (const m of relMatches) {
    relatedEntities.push({
      dimension: m[1] as "subject" | "type" | "scenario",
      name: m[2],
    });
  }

  return {
    dimension: (meta.dimension as EntityDocument["dimension"]) || "subject",
    name: meta.name || "",
    description: desc,
    eventIds,
    relatedEntities,
    createdAt: meta.created ? Date.parse(meta.created) : Date.now(),
    lastUpdated: meta.lastUpdated ? Date.parse(meta.lastUpdated) : Date.now(),
  };
}

function escapeTable(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
