import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StoryDocument } from "./story-types.js";
import { ContentStorage } from "./content-storage.js";

// ── YAML Frontmatter Parse/Serialize ──────────────────────────────

function serializeFrontmatter(meta: Record<string, string>, body: string): string {
  const lines = Object.entries(meta)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${lines}\n---\n${body}`;
}

// ── Story Storage ──────────────────────────────────────────────────

export class StoryStorage {
  constructor(private readonly storage: ContentStorage) {}

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
      "| # | Messages | Time | Snippet |",
      "|---|----------|------|---------|",
      ...doc.sources.map(
        (s, i) =>
          `| ${i + 1} | ${s.messageRange[0]} - ${s.messageRange[1]} | ${new Date(s.timestamp).toISOString().slice(0, 16)} | ${escapeTable(s.snippet.slice(0, 60))} |`,
      ),
    ].join("\n");

    const content = serializeFrontmatter(meta, body);
    const absPath = this.storage.resolvePath(sessionId, `stories/${doc.id}.md`);
    await mkdir(join(absPath, ".."), { recursive: true });
    await writeFile(absPath, content, "utf-8");
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function escapeTable(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
