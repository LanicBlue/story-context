import type { StorySummary, StoryAttributes } from "./story-types.js";
import type { Summarizer } from "./types.js";
import { extractText, extractRole, extractToolName, extractToolArg } from "./compactor.js";

// ── LLM Prompt Templates ──────────────────────────────────────────

export const STORY_EXTRACT_SYSTEM_PROMPT =
  "You are a conversation compression engine. /no_think\n" +
  "Task: Read the conversation and extract stories.\n" +
  "For each story, provide:\n" +
  "1. subject: the main entity (project name, module, concept, person)\n" +
  "2. type: activity type (development, investigation, troubleshooting, decision, discussion, deployment, analysis)\n" +
  "3. scenario: context (production, development, testing, client engagement, configuration)\n" +
  "4. content: a concise 2-3 sentence narrative describing what happened\n\n" +
  "IMPORTANT:\n" +
  "- Write narrative summaries, do NOT copy raw text or JSON from the conversation\n" +
  "- Each content section must be your own summary of what occurred\n" +
  "- Omit tool output details, file contents, and API responses\n\n" +
  "Output format:\n" +
  "---STORY---\n## subject\n<value>\n## type\n<value>\n## scenario\n<value>\n## content\n<your narrative summary>\n---END---";

export const STORY_EXTRACT_USER_TEMPLATE = `Analyze the conversation below and extract stories.

[Context before]
{preOverlap}

[Conversation to analyze]
{core}

[Context after]
{postOverlap}

Extract stories using the ---STORY--- format. Write narrative summaries, not raw text.`;

export const SEMANTIC_MATCH_PROMPT =
  "Determine whether the attributes of the following two stories semantically match. " +
  "Values expressing the same concept with different wording also count as matching. " +
  'Output JSON: {"subject": true/false, "type": true/false, "scenario": true/false}';

// ── Parse LLM Output ──────────────────────────────────────────────

/** Parse story-oriented LLM output into StorySummary array. */
export function parseStoryOrientedOutput(
  markdown: string,
  sourceSummary: string,
  messageRange: [number, number],
): StorySummary[] {
  const stories: StorySummary[] = [];
  const blocks = markdown.split(/---STORY---/).filter((b) => b.trim());

  for (const block of blocks) {
    const cleaned = block.replace(/---END---/g, "").trim();
    const subject = extractSection(cleaned, "subject");
    const type = extractSection(cleaned, "type");
    const scenario = extractSection(cleaned, "scenario");
    const content = extractSection(cleaned, "content");

    // Skip stories with no meaningful content
    if (!content || content.trim().length < 10) continue;

    stories.push({
      content: content.trim(),
      attributes: {
        subject: subject?.trim() || "未知",
        type: type?.trim() || "对话",
        scenario: scenario?.trim() || "通用",
      },
      sourceSummary,
      messageRange,
      timestamp: Date.now(),
    });
  }

  // Fallback: if no structured stories found, treat entire output as one story
  if (stories.length === 0 && markdown.trim()) {
    stories.push({
      content: markdown.trim(),
      attributes: { subject: "未知", type: "对话", scenario: "通用" },
      sourceSummary,
      messageRange,
      timestamp: Date.now(),
    });
  }

  return stories;
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
      if (knownDimensions.subjects.length > 0) parts.push(`Known subjects: ${knownDimensions.subjects.join(", ")}`);
      if (knownDimensions.types.length > 0) parts.push(`Known types: ${knownDimensions.types.join(", ")}`);
      if (knownDimensions.scenarios.length > 0) parts.push(`Known scenarios: ${knownDimensions.scenarios.join(", ")}`);
      if (parts.length > 0) {
        knownHint = `\n\nPrefer reusing known dimension values when they fit. ${parts.join(". ")}`;
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
  let subject = "未知";
  if (known && known.subjects.length > 0) {
    subject = matchKnown(allText, known.subjects) ?? inferSubject(files, userText);
  } else {
    subject = inferSubject(files, userText);
  }

  // Type: match against known values first
  let type = "对话";
  if (known && known.types.length > 0) {
    type = matchKnown(allText, known.types) ?? inferType(hasWrite, hasShellError, files.size);
  } else {
    type = inferType(hasWrite, hasShellError, files.size);
  }

  // Scenario: match against known values first
  let scenario = "通用";
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
  if (hasWrite) return "软件开发";
  if (hasShellError) return "故障排查";
  if (fileCount > 0) return "调研";
  return "对话";
}

function inferScenario(files: Set<string>): string {
  if (files.size > 0) {
    const allPaths = [...files].join(" ");
    if (/test|spec/i.test(allPaths)) return "测试";
    if (/config|setup/i.test(allPaths)) return "配置";
    if (/deploy|ci|cd/i.test(allPaths)) return "部署";
    return "开发环境";
  }
  return "通用";
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
