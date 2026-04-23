import type { StorySummary, StoryAttributes } from "./story-types.js";
import type { Summarizer } from "./types.js";
import { extractText, extractRole, extractToolName, extractToolArg } from "./compactor.js";

// ── LLM Prompt Templates ──────────────────────────────────────────

export const STORY_EXTRACT_SYSTEM_PROMPT =
  "You are a conversation compression engine. /no_think\n" +
  "[Schema]\n" +
  "Extract stories as a JSON array. Each element:\n" +
  '{ "subject": "<target entity>", "type": "<agent action>", "scenario": "<work domain>", "content": "<narrative>" }\n\n' +
  "[Rules]\n" +
  "- subject: the target entity the agent is working on (project name, system name, topic). Short, stable, noun phrase.\n" +
  "- type: the agent's action. Pick ONE from {development|testing|execution|exploration|assistance|debugging|analysis|decision|configuration}. Create new only if none fits.\n" +
  "- scenario: the work domain. Pick ONE from {software-engineering|data-engineering|system-ops|security|content-creation|knowledge-mgmt|user-interaction|general}.\n" +
  "- content: concise 2-3 sentence narrative. Do NOT copy raw text or JSON.\n" +
  "- Omit tool output details, file contents, and API responses.\n" +
  "- Each field must be a SINGLE value. NO comma-separated lists.\n\n" +
  "[Output]\n" +
  "Output ONLY a JSON array. No markdown fences. No extra text.\n" +
  'Example: [{"subject":"opinion-analysis","type":"development","scenario":"software-engineering","content":"Built a multi-platform crawler pipeline."}]';

export const STORY_EXTRACT_USER_TEMPLATE = `Analyze the conversation below and extract stories.

[Context before]
{preOverlap}

[Conversation to analyze]
{core}

[Context after]
{postOverlap}

Extract stories as JSON. Write narrative summaries, not raw text.`;

export const SEMANTIC_MATCH_PROMPT =
  "Determine whether the attributes of the following two stories semantically match. " +
  "Values expressing the same concept with different wording also count as matching. " +
  'Output JSON: {"match": true/false}';

// ── Dimension Normalization ────────────────────────────────────────

/** Normalize a dimension value: take first item from comma-separated lists. */
export function normalizeDimensionValue(val: string): string {
  return val.split(/[,，、]/)[0].trim() || val;
}

// ── Parse LLM Output ──────────────────────────────────────────────

/** Parse LLM output into StorySummary array. Tries JSON first, falls back to ---STORY--- format. */
export function parseStoryOrientedOutput(
  markdown: string,
  sourceSummary: string,
  messageRange: [number, number],
): StorySummary[] {
  // Try JSON array first
  const jsonStories = parseStoryJsonOutput(markdown, sourceSummary, messageRange);
  if (jsonStories.length > 0) return jsonStories;

  // Legacy: ---STORY--- blocks
  const stories: StorySummary[] = [];
  const blocks = markdown.split(/---STORY---/).filter((b) => b.trim());

  for (const block of blocks) {
    const cleaned = block.replace(/---END---/g, "").trim();
    const subject = extractSection(cleaned, "subject");
    const type = extractSection(cleaned, "type");
    const scenario = extractSection(cleaned, "scenario");
    const content = extractSection(cleaned, "content");

    if (!content || content.trim().length < 5) continue;

    stories.push({
      content: content.trim(),
      attributes: {
        subject: normalizeDimensionValue(subject?.trim() || "unknown"),
        type: normalizeDimensionValue(type?.trim() || "assistance"),
        scenario: normalizeDimensionValue(scenario?.trim() || "general"),
      },
      sourceSummary,
      messageRange,
      timestamp: Date.now(),
    });
  }

  // Fallback: treat entire output as one story
  if (stories.length === 0 && markdown.trim()) {
    stories.push({
      content: markdown.trim(),
      attributes: { subject: "unknown", type: "assistance", scenario: "general" },
      sourceSummary,
      messageRange,
      timestamp: Date.now(),
    });
  }

  return stories;
}

/** Parse JSON array output from LLM. */
function parseStoryJsonOutput(
  raw: string,
  sourceSummary: string,
  messageRange: [number, number],
): StorySummary[] {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

  // Try to find a JSON array
  const arrMatch = text.match(/\[[\s\S]*\]/);
  // If no array, try a single JSON object
  const objMatch = !arrMatch ? text.match(/\{[\s\S]*\}/) : null;
  if (!arrMatch && !objMatch) return [];

  try {
    let arr: unknown[];
    if (arrMatch) {
      const parsed = JSON.parse(arrMatch[0]);
      arr = Array.isArray(parsed) ? parsed : [parsed];
    } else {
      const parsed = JSON.parse(objMatch![0]);
      arr = [parsed];
    }

    const stories: StorySummary[] = [];
    for (const raw of arr) {
      const item = raw as Record<string, unknown>;
      const content = typeof item.content === "string" ? item.content.trim() : "";
      if (content.length < 5) continue;

      stories.push({
        content,
        attributes: {
          subject: normalizeDimensionValue(typeof item.subject === "string" ? item.subject.trim() : "unknown"),
          type: normalizeDimensionValue(typeof item.type === "string" ? item.type.trim() : "assistance"),
          scenario: normalizeDimensionValue(typeof item.scenario === "string" ? item.scenario.trim() : "general"),
        },
        sourceSummary,
        messageRange,
        timestamp: Date.now(),
      });
    }
    return stories;
  } catch {
    return [];
  }
}

function extractSection(text: string, heading: string): string | undefined {
  const lines = text.split("\n");
  let capturing = false;
  const captured: string[] = [];
  const target = "## " + heading;

  for (const line of lines) {
    if (capturing) {
      if (line.startsWith("## ")) break;
      captured.push(line);
    } else if (line === target) {
      capturing = true;
    }
  }

  return captured.length > 0 ? captured.join("\n").trim() : undefined;
}

/** Format parsed stories as structured markdown for summary file output. */
export function formatStoriesAsMarkdown(stories: StorySummary[]): string {
  if (stories.length === 0) return "";

  return stories.map((s, i) => {
    const title = `${s.attributes.subject} — ${s.attributes.type} · ${s.attributes.scenario}`;
    return `## ${i + 1}. ${title}\n\n${s.content}`;
  }).join("\n\n---\n\n");
}

/** Extract stories using LLM, falling back to structural extraction on failure. */
export async function extractStoriesWithLLM(
  coreMessages: unknown[],
  preOverlap: string,
  postOverlap: string,
  summarizer: Summarizer,
  sourceSummary: string,
  messageRange: [number, number],
  knownDimensions?: KnownDimensions,
): Promise<{ rawOutput: string; stories: StorySummary[] }> {
  try {
    // Use already-processed message text (metadata stripped, large text outlined)
    const coreText = coreMessages
      .map((m) => `[${extractRole(m)}]: ${extractText(m)}`)
      .join("\n\n");

    const prompt = STORY_EXTRACT_USER_TEMPLATE
      .replace("{preOverlap}", preOverlap || "(none)")
      .replace("{core}", coreText)
      .replace("{postOverlap}", postOverlap || "(none)");

    let knownHint = "";
    if (knownDimensions) {
      const parts: string[] = [];
      if (knownDimensions.subjects.length > 0) parts.push(`subject: {${knownDimensions.subjects.join(", ")}}`);
      if (knownDimensions.types.length > 0) parts.push(`type: {${knownDimensions.types.join(", ")}}`);
      if (knownDimensions.scenarios.length > 0) parts.push(`scenario: {${knownDimensions.scenarios.join(", ")}}`);
      if (parts.length > 0) {
        knownHint = `\n\n[Known Schema — MUST reuse existing values]\n${parts.join("\n")}\nRule: semantically similar MUST merge into existing values. Each field MUST be a SINGLE value.`;
      }
    }

    const fullPrompt = STORY_EXTRACT_SYSTEM_PROMPT + "\n\n" + prompt + knownHint;
    const rawOutput = await summarizer.summarize(fullPrompt, 2000);

    const stories = parseStoryOrientedOutput(rawOutput, sourceSummary, messageRange);

    if (stories.length === 0) {
      return { rawOutput, stories: extractStoriesStructural(coreMessages, sourceSummary, messageRange, knownDimensions) };
    }

    return { rawOutput, stories };
  } catch {
    return { rawOutput: "", stories: extractStoriesStructural(coreMessages, sourceSummary, messageRange, knownDimensions) };
  }
}

// ── Structural Fallback (No LLM) ──────────────────────────────────

export type KnownDimensions = {
  subjects: string[];
  types: string[];
  scenarios: string[];
};

/** Extract stories structurally from messages without LLM. */
export function extractStoriesStructural(
  coreMessages: unknown[],
  sourceSummary: string,
  messageRange: [number, number],
  knownDimensions?: KnownDimensions,
): StorySummary[] {
  // Group messages into story segments by detecting topic boundaries
  const segments = detectStorySegments(coreMessages);

  return segments.map((seg) => {
    const attrs = extractAttributesFromSegment(seg.messages, knownDimensions);
    const content = buildContentFromSegment(seg.messages);

    return {
      content,
      attributes: attrs,
      sourceSummary,
      messageRange,
      timestamp: Date.now(),
    };
  });
}

type MessageSegment = {
  messages: unknown[];
};

function detectStorySegments(messages: unknown[]): MessageSegment[] {
  if (messages.length === 0) return [];

  const segments: MessageSegment[] = [{ messages: [] }];
  let currentFiles = new Set<string>();

  for (const msg of messages) {
    const role = extractRole(msg);
    const toolName = extractToolName(msg);
    const filePath = extractToolArg(msg, "path");

    // Detect boundary: user message with no file overlap from previous segment
    if (role === "user" && segments[0].messages.length > 0) {
      const msgFiles = new Set<string>();
      // Look ahead at tool calls after this user message
      if (filePath) msgFiles.add(filePath);

      // If user message introduces completely new files, start new segment
      const hasOverlap = filePath && currentFiles.has(filePath);
      if (!hasOverlap && segments[segments.length - 1].messages.length > 0) {
        segments.push({ messages: [] });
        currentFiles = new Set();
      }
    }

    if (filePath && (toolName === "read_file" || toolName === "write_file" || toolName === "patch_file")) {
      currentFiles.add(filePath);
    }

    segments[segments.length - 1].messages.push(msg);
  }

  return segments.filter((s) => s.messages.length > 0);
}

function extractAttributesFromSegment(messages: unknown[], known?: KnownDimensions): StoryAttributes {
  const files = new Set<string>();
  let hasWrite = false;
  let hasShellError = false;
  let userText = "";

  for (const msg of messages) {
    const role = extractRole(msg);
    const toolName = extractToolName(msg);
    const filePath = extractToolArg(msg, "path");

    if (filePath && (toolName === "read_file" || toolName === "write_file" || toolName === "patch_file")) {
      files.add(filePath);
    }
    if (toolName === "write_file" || toolName === "patch_file") hasWrite = true;
    if (toolName === "run_shell") {
      const text = extractText(msg);
      if (/error|fail|exception/i.test(text)) hasShellError = true;
    }
    if (role === "user") {
      userText = extractText(msg);
    }
  }

  // Collect all text for matching
  const allText = [
    ...[...files],
    userText,
    ...[...messages].map((m) => extractText(m)),
  ].filter(Boolean).join(" ").toLowerCase();

  // Subject: match against known values first
  let subject = "unknown";
  if (known && known.subjects.length > 0) {
    subject = matchKnown(allText, known.subjects) ?? inferSubject(files, userText);
  } else {
    subject = inferSubject(files, userText);
  }

  // Type: match against known values first
  let type = "assistance";
  if (known && known.types.length > 0) {
    type = matchKnown(allText, known.types) ?? inferType(hasWrite, hasShellError, files.size);
  } else {
    type = inferType(hasWrite, hasShellError, files.size);
  }

  // Scenario: match against known values first
  let scenario = "general";
  if (known && known.scenarios.length > 0) {
    scenario = matchKnown(allText, known.scenarios) ?? inferScenario(files);
  } else {
    scenario = inferScenario(files);
  }

  return { subject, type, scenario };
}

/** Find the best-matching known value by checking substring overlap. */
function matchKnown(text: string, knownValues: string[]): string | undefined {
  const textLower = text.toLowerCase();
  for (const v of knownValues) {
    // Exact substring match in conversation text
    if (textLower.includes(v.toLowerCase())) return v;
    // Also check if the known value contains key tokens from the text
    const tokens = v.toLowerCase().split(/\s+/);
    if (tokens.length > 1 && tokens.every((t) => t.length > 2 && textLower.includes(t))) return v;
  }
  return undefined;
}

function inferSubject(files: Set<string>, userText: string): string {
  if (files.size > 0) {
    const paths = [...files];
    const commonDir = extractCommonPrefix(paths);
    return commonDir || paths[0].split("/")[0] || "未知";
  }
  if (userText) {
    return userText.slice(0, 30).replace(/\n/g, " ").trim();
  }
  return "未知";
}

function inferType(hasWrite: boolean, hasShellError: boolean, fileCount: number): string {
  if (hasWrite) return "development";
  if (hasShellError) return "debugging";
  if (fileCount > 0) return "exploration";
  return "assistance";
}

function inferScenario(files: Set<string>): string {
  if (files.size > 0) {
    const allPaths = [...files].join(" ");
    if (/test|spec/i.test(allPaths)) return "software-engineering";
    if (/config|setup/i.test(allPaths)) return "system-ops";
    if (/deploy|ci|cd/i.test(allPaths)) return "system-ops";
    return "software-engineering";
  }
  return "general";
}

function extractCommonPrefix(paths: string[]): string {
  if (paths.length === 0) return "";
  const parts = paths.map((p) => p.split("/"));
  const first = parts[0];
  let common = "";
  for (let i = 0; i < first.length; i++) {
    const seg = first[i];
    if (parts.every((p) => p[i] === seg)) {
      common = common ? `${common}/${seg}` : seg;
    } else {
      break;
    }
  }
  return common;
}

function buildContentFromSegment(messages: unknown[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    const role = extractRole(msg);
    const text = extractText(msg);
    if (!text) continue;

    if (role === "user") {
      parts.push(`用户要求: ${text.replace(/\n/g, " ").slice(0, 100)}`);
    } else if (role === "toolResult") {
      const toolName = extractToolName(msg);
      const filePath = extractToolArg(msg, "path");
      const summary = text.replace(/\n/g, " ").slice(0, 80);
      parts.push(`${toolName}${filePath ? ` ${filePath}` : ""}: ${summary}`);
    } else if (role === "assistant") {
      const sentences = text
        .split(/[.!?。！？\n]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 10);
      if (sentences.length > 0) {
        parts.push(sentences[0].slice(0, 100));
      }
    }
  }

  return parts.join("\n");
}
