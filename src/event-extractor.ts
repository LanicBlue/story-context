import type { EventSummary, EventAttributes } from "./event-types.js";
import { extractText, extractRole, extractToolName, extractToolArg } from "./compactor.js";

// ── LLM Prompt Templates ──────────────────────────────────────────

export const EVENT_EXTRACT_SYSTEM_PROMPT =
  "You are a conversation compression engine. Decompose the conversation into discrete events. " +
  "For each event, extract three attribute dimensions, then write an event summary.\n" +
  "Attribute dimensions:\n" +
  "- subject: What entity this event is about (project, system, module, concept, person, etc.)\n" +
  "- type: Event category (software development, investigation, troubleshooting, decision, discussion, deployment, requirement analysis, etc.)\n" +
  "- scenario: Application context (production, tech selection, client engagement, authentication flow, etc.)\n" +
  "Output format (one block per event):\n" +
  "---EVENT---\n## subject\n<value>\n## type\n<value>\n## scenario\n<value>\n## content\n<2-5 sentence narrative>\n---END---\n" +
  "Rules: one coherent activity = one event; different subject/type/scenario = different events; " +
  "same dimension can use different expressions (e.g. \"bug fix\" and \"defect repair\" are synonyms); " +
  "content records decisions and results, omit filler; if the whole segment is one event, output only one block.";

export const EVENT_EXTRACT_USER_TEMPLATE = `The following are consecutive conversation segments. Decompose them into independent events and extract attributes.

[Preceding Context]
{preOverlap}

[Core Content — Decompose into events]
{core}

[Following Context]
{postOverlap}

Output each event using the ---EVENT--- format.`;

export const SEMANTIC_MATCH_PROMPT =
  "Determine whether the attributes of the following two events semantically match. " +
  "Values expressing the same concept with different wording also count as matching. " +
  'Output JSON: {"subject": true/false, "type": true/false, "scenario": true/false}';

// ── Parse LLM Output ──────────────────────────────────────────────

/** Parse event-oriented LLM output into EventSummary array. */
export function parseEventOrientedOutput(
  markdown: string,
  sourceSummary: string,
  messageRange: [number, number],
): EventSummary[] {
  const events: EventSummary[] = [];
  const blocks = markdown.split(/---EVENT---/).filter((b) => b.trim());

  for (const block of blocks) {
    const cleaned = block.replace(/---END---/, "").trim();
    const subject = extractSection(cleaned, "subject");
    const type = extractSection(cleaned, "type");
    const scenario = extractSection(cleaned, "scenario");
    const content = extractSection(cleaned, "content");

    if (!content) continue;

    events.push({
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

  // Fallback: if no structured events found, treat entire output as one event
  if (events.length === 0 && markdown.trim()) {
    events.push({
      content: markdown.trim(),
      attributes: { subject: "未知", type: "对话", scenario: "通用" },
      sourceSummary,
      messageRange,
      timestamp: Date.now(),
    });
  }

  return events;
}

function extractSection(text: string, heading: string): string | undefined {
  const regex = new RegExp(`^##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=^##\\s|$(?!\\n))`, "m");
  const match = regex.exec(text);
  return match?.[1]?.trim();
}

// ── Structural Fallback (No LLM) ──────────────────────────────────

/** Extract events structurally from messages without LLM. */
export function extractEventsStructural(
  coreMessages: unknown[],
  sourceSummary: string,
  messageRange: [number, number],
): EventSummary[] {
  // Group messages into event segments by detecting topic boundaries
  const segments = detectEventSegments(coreMessages);

  return segments.map((seg) => {
    const attrs = extractAttributesFromSegment(seg.messages);
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

function detectEventSegments(messages: unknown[]): MessageSegment[] {
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

function extractAttributesFromSegment(messages: unknown[]): EventAttributes {
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

  // Subject: project name or primary file directory
  let subject = "未知";
  if (files.size > 0) {
    const paths = [...files];
    const commonDir = extractCommonPrefix(paths);
    subject = commonDir || paths[0].split("/")[0] || "未知";
  } else if (userText) {
    subject = userText.slice(0, 30).replace(/\n/g, " ").trim();
  }

  // Type: infer from message patterns
  let type = "对话";
  if (hasWrite) type = "软件开发";
  else if (hasShellError) type = "故障排查";
  else if (files.size > 0) type = "调研";

  // Scenario: infer from file paths and keywords
  let scenario = "通用";
  if (files.size > 0) {
    const allPaths = [...files].join(" ");
    if (/test|spec/i.test(allPaths)) scenario = "测试";
    else if (/config|setup/i.test(allPaths)) scenario = "配置";
    else if (/deploy|ci|cd/i.test(allPaths)) scenario = "部署";
    else scenario = "开发环境";
  }

  return { subject, type, scenario };
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
