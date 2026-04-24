import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { StoryDocument, EntityDocument } from "./story-types.js";
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

// ── Story Storage ──────────────────────────────────────────────────

export class StoryStorage {
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

  // ── Story documents ────────────────────────────────────────────

  /** Write a story document to stories/{id}.md */
  async writeStoryDocument(sessionId: string, doc: StoryDocument): Promise<void> {
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
    const absPath = this.storage.resolvePath(sessionId, `stories/${doc.id}.md`);
    await mkdir(join(absPath, ".."), { recursive: true });
    await writeFile(absPath, content, "utf-8");
  }

  /** Read a story document from disk. */
  async readStoryDocument(sessionId: string, storyId: string): Promise<StoryDocument | undefined> {
    try {
      const absPath = this.storage.resolvePath(sessionId, `stories/${storyId}.md`);
      const raw = await readFile(absPath, "utf-8");
      return parseStoryDocument(raw);
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

    const body = [
      `# ${doc.name}\n`,
      `## Description\n`,
      doc.description + "\n",
      `## Stories\n`,
      ...doc.storyIds.map((sid) => `- [[${sid}]]`),
      doc.storyIds.length === 0 ? "- (none)" : "",
      `\n## Related Entities\n`,
      ...doc.relatedEntities.map(
        (re) => `- [[${re.dimension}:${re.name}]]`,
      ),
      doc.relatedEntities.length === 0 ? "- (none)" : "",
    ].join("\n");

    const content = serializeFrontmatter(meta, body);
    const dir = `${doc.dimension}s`; // subjects/ types/ scenarios/
    const safeName = sanitizeFilename(doc.name);
    const absPath = this.storage.resolvePath(sessionId, `${dir}/${safeName}.md`);
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
      const absPath = this.storage.resolvePath(sessionId, `${dir}/${sanitizeFilename(name)}.md`);
      const raw = await readFile(absPath, "utf-8");
      return parseEntityDocument(raw);
    } catch {
      return undefined;
    }
  }

  /** List all story IDs on disk. */
  async listStoryIds(sessionId: string): Promise<string[]> {
    try {
      const dir = this.storage.resolvePath(sessionId, "stories");
      const files = await readdir(dir);
      return files
        .filter((f) => f.startsWith("story-") && f.endsWith(".md"))
        .map((f) => f.replace(/\.md$/, ""));
    } catch {
      return [];
    }
  }

  /** Read a summary file and extract sections for story context. */
  async readSummaryPartials(
    sessionId: string,
    relPath: string,
  ): Promise<SummaryPartials> {
    try {
      const absPath = this.storage.resolvePath(sessionId, relPath);
      const raw = await readFile(absPath, "utf-8");
      return parseSummaryPartials(raw);
    } catch {
      return { task: "", files: [], operations: [] };
    }
  }

  /** Read full summary content from disk. */
  async readSummaryContent(sessionId: string, relPath: string): Promise<string> {
    try {
      const absPath = this.storage.resolvePath(sessionId, relPath);
      return await readFile(absPath, "utf-8");
    } catch {
      return "";
    }
  }
}

// ── Parse helpers ──────────────────────────────────────────────────

function parseStoryDocument(raw: string): StoryDocument {
  const { meta, body } = parseFrontmatter(raw);

  // Extract attributes from wiki links in the body
  const subjectMatch = body.match(/\[\[subject:([^\]]+)\]\]/);
  const typeMatch = body.match(/\[\[type:([^\]]+)\]\]/);
  const scenarioMatch = body.match(/\[\[scenario:([^\]]+)\]\]/);

  // Extract sources from table rows
  const sources: StoryDocument["sources"] = [];
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
    status: (meta.status as StoryDocument["status"]) || "active",
    narrative: narrativeMatch?.[1]?.trim() || "",
    activeUntilTurn: typeof meta.activeUntilTurn === "number" ? meta.activeUntilTurn : 0,
    lastEditedTurn: typeof meta.lastEditedTurn === "number" ? meta.lastEditedTurn : 0,
    createdAt: meta.created ? Date.parse(meta.created) : Date.now(),
    lastUpdated: meta.lastUpdated ? Date.parse(meta.lastUpdated) : Date.now(),
  };
}

function parseEntityDocument(raw: string): EntityDocument {
  const { meta, body } = parseFrontmatter(raw);

  // Extract story IDs from [[story-xxx]] links
  const storyIds = [...body.matchAll(/\[\[(story-[^\]]+)\]\]/g)].map((m) => m[1]);

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
    storyIds,
    relatedEntities,
    createdAt: meta.created ? Date.parse(meta.created) : Date.now(),
    lastUpdated: meta.lastUpdated ? Date.parse(meta.lastUpdated) : Date.now(),
  };
}

export type SummaryPartials = {
  task: string;
  files: string[];
  operations: Array<{ op: string; target: string; result: string }>;
};

function parseSummaryPartials(raw: string): SummaryPartials {
  const result: SummaryPartials = { task: "", files: [], operations: [] };

  // Extract task
  const taskMatch = raw.match(/## Task Intent\s*\n([\s\S]*?)(?=\n## |\n$)/);
  if (taskMatch) {
    result.task = taskMatch[1].replace(/^-\s*/gm, "").trim();
  }

  // Extract files from "File Changes" section
  const fileMatch = raw.match(/## File Changes\s*\n([\s\S]*?)(?=\n## |\n$)/);
  if (fileMatch) {
    for (const line of fileMatch[1].split("\n")) {
      const m = line.match(/^-\s*(.+)$/);
      if (m) result.files.push(m[1].trim());
    }
  }

  // Extract operations from table
  const opSection = raw.match(/## Operations\s*\n([\s\S]*?)(?=\n## |\n$)/);
  if (opSection) {
    const rows = opSection[1].matchAll(/\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g);
    for (const m of rows) {
      const op = m[1].trim();
      if (op === "Operation" || op.startsWith("-")) continue;
      result.operations.push({
        op,
        target: m[2].trim(),
        result: m[3].trim(),
      });
    }
  }

  return result;
}

function escapeTable(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Sanitize a string for use as a filename: replace unsafe chars with underscores. */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 100);
}
