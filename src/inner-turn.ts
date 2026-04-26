import type { Summarizer } from "./types.js";
import type { StoryDocument, StoryAttributes } from "./story-types.js";
import type { StoryIndexManager } from "./story-index.js";
import { extractText } from "./engine.js";

// ── Local helpers ────────────────────────────────────────────────

function extractRole(msg: unknown): string {
  return (msg as { role?: string }).role ?? "unknown";
}

// ── Preset Values ─────────────────────────────────────────────────

export const TYPE_PRESETS = [
  "person", "project", "tool", "device", "document",
  "dataset", "event", "workflow", "organization", "concept",
  "environment", "place",
] as const;

export const SCENARIO_PRESETS = [
  "bug-fix", "feature-development", "deployment", "code-review",
  "architecture-design", "debugging", "investigation", "discussion",
  "refactoring", "configuration", "testing", "optimization",
] as const;

// ── Prompt Constants ────────────────────────────────────────────

const INNER_TURN_B_SYSTEM_PROMPT = [
  "你是 story 管理助手。分析消息，输出一组 story 操作。 /no_think",
  "",
  "输出 JSON:",
  '{"actions":[{"action":"create","story":{"subject":"...","type":"...","scenario":"...","content":"..."}},{"action":"update","target":{"subject":"...","type":"...","scenario":"..."},"updatedContent":"...","append":true/false}]}',
  "",
  "无变化: {\"actions\":[]}",
  "",
  "规则:",
  "- 可同时创建和更新多个 story",
  "- subject: 消息实际谈论的对象。可以是实体（n8n, 即刻平台）或概念/现象（苹果下落, 数据污染）。",
  "  根据对话焦点判断粒度：讨论苹果→用苹果，讨论苹果下落现象→用苹果下落。",
  "  不加多余修饰词。正确: n8n, 即刻平台, 工作流51。错误: n8n工具, 即刻平台API。",
  "- type: 主体类型。从枚举值中选择最匹配的。",
  "- scenario: 动作名称。从枚举值中选择最匹配的。",
  "- content 是 2-3 句叙事摘要，不要复制原文",
  "- update 操作通过 target 三维度定位已有 story（不需要 ID）",
].join("\n");

const INNER_TURN_A_SYSTEM_PROMPT = [
  "你是内容过滤规则助手。分析当前规则效果，输出修改后的完整规则组。 /no_think",
  "",
  "输出 JSON:",
  '{"rules":[{"match":"contains|regex","pattern":"...","granularity":"message|block|line"}],"reason":"..."}',
  "",
  "规则:",
  "- match 只能是 contains 或 regex",
  "- granularity 只能是 message、block 或 line",
  "- pattern 是匹配模式",
  "- 输出完整规则组（替换所有现有规则）",
  "- 如无需修改，原样输出当前规则组",
  "- 确保输出有效 JSON",
].join("\n");

// ── Types ───────────────────────────────────────────────────────

export type InnerTurnBAction = {
  action: "create" | "update" | "skip";
  story?: { subject: string; type: string; scenario: string; content: string };
  target?: { subject: string; type: string; scenario: string };
  updatedContent?: string;
  append?: boolean;
};

export type InnerTurnBOutput = {
  actions: InnerTurnBAction[];
};

export type InnerTurnAResult = {
  rules: Array<{ match: "contains" | "regex"; pattern: string; granularity: "message" | "block" | "line" }>;
  reason: string;
};

export type InnerTurnResult = {
  success: boolean;
  createdCount: number;
  updatedCount: number;
  error?: string;
};

type InnerTurnDeps = {
  summarizer: Summarizer;
  storyManager: StoryIndexManager;
  currentTurn: number;
  activeStoryTTL: number;
  maxActiveStories: number;
  sampleMessages: () => string;
  sampleRawCleaned: () => { raw: string; cleaned: string }[];
  currentFilters: () => Array<{ match: "contains" | "regex"; pattern: string; caseSensitive?: boolean; granularity: "message" | "block" | "line" }>;
  applyFilterRules: (rules: InnerTurnAResult["rules"]) => void;
};

// ── Main Loop ───────────────────────────────────────────────────

const MAX_B_RETRIES = 3;
const MAX_A_RETRIES = 3;

export async function runInnerTurn(deps: InnerTurnDeps): Promise<InnerTurnResult> {
  for (let attempt = 0; attempt < MAX_B_RETRIES; attempt++) {
    const bResult = await runInnerTurnB(deps);

    if (bResult.success) {
      return {
        success: true,
        createdCount: bResult.createdCount,
        updatedCount: bResult.updatedCount,
      };
    }

    // B failed → run A to recover
    let aSuccess = false;
    let lastAError = "";
    for (let aAttempt = 0; aAttempt < MAX_A_RETRIES; aAttempt++) {
      const aResult = await runInnerTurnA(deps, bResult.error ?? "unknown error", lastAError);
      if (aResult) {
        aSuccess = true;
        break;
      }
      lastAError = "A failed to produce valid rules";
    }

    if (!aSuccess) {
      return { success: false, createdCount: 0, updatedCount: 0, error: "A failed after retries" };
    }

    // A succeeded → rules updated → retry B (outer loop)
  }

  return { success: false, createdCount: 0, updatedCount: 0, error: "B failed after retries" };
}

// ── InnerTurnB ──────────────────────────────────────────────────

type BResult = {
  success: boolean;
  createdCount: number;
  updatedCount: number;
  error?: string;
};

async function runInnerTurnB(deps: InnerTurnDeps): Promise<BResult> {
  const { summarizer, storyManager, currentTurn, activeStoryTTL, maxActiveStories } = deps;
  const stories = storyManager.getAllStories();
  const dims = storyManager.getKnownDimensions();

  // Build prompt
  const storyListStr = stories.length > 0
    ? stories.map(s =>
        `[${s.id}] ${s.attributes.subject} | ${s.attributes.type} | ${s.attributes.scenario}\n${s.narrative.slice(0, 150)}`
      ).join("\n")
    : "(none)";

  const dimsStr = [
    buildDimLine("subject", dims.subjects),
    buildDimLine("type", mergePresets(TYPE_PRESETS, dims.types)),
    buildDimLine("scenario", mergePresets(SCENARIO_PRESETS, dims.scenarios)),
  ].join("\n");

  const messagesStr = deps.sampleMessages();

  const prompt = [
    "## 已有 Stories",
    storyListStr,
    "",
    "## 已知维度值（优先复用）",
    dimsStr || "(none)",
    "",
    "## 最近清理后消息",
    messagesStr,
    "",
    "分析消息，决定创建新 story 或更新已有 story。输出 JSON。",
  ].join("\n");

  try {
    const output = await summarizer.rawGenerate(INNER_TURN_B_SYSTEM_PROMPT, prompt, 1000);
    const parsed = parseBOutput(output);

    if (!parsed) {
      return { success: false, createdCount: 0, updatedCount: 0, error: "B JSON parse failed" };
    }

    if (parsed.actions.length === 0) {
      return { success: true, createdCount: 0, updatedCount: 0 }; // skip
    }

    // Check if any action requires update → Round 2
    const updateActions = parsed.actions.filter(a => a.action === "update");
    let confirmedActions = parsed.actions;

    if (updateActions.length > 0) {
      const round2Result = await runInnerTurnBRound2(summarizer, stories, updateActions);
      if (!round2Result.success) {
        return { success: false, createdCount: 0, updatedCount: 0, error: round2Result.error };
      }
      // Replace update actions with confirmed versions
      confirmedActions = parsed.actions.map(a => {
        if (a.action !== "update") return a;
        const confirmed = round2Result.confirmed!.find(c => {
          const ct = c.target;
          const at = a.target;
          if (!ct || !at) return false;
          return ct.subject === at.subject && ct.type === at.type && ct.scenario === at.scenario;
        });
        return confirmed ?? a;
      });
    }

    // Execute all actions (all-or-nothing)
    return executeBActions(deps, confirmedActions);
  } catch (err) {
    return {
      success: false,
      createdCount: 0,
      updatedCount: 0,
      error: `B rawGenerate error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function runInnerTurnBRound2(
  summarizer: Summarizer,
  stories: StoryDocument[],
  updateActions: InnerTurnBAction[],
): Promise<{ success: boolean; confirmed?: InnerTurnBAction[]; error?: string }> {
  const storyDetails = updateActions.map(a => {
    const t = a.target;
    if (!t) return `[ERROR] Update action missing target dimensions`;
    const doc = stories.find(s =>
      s.attributes.subject === t.subject &&
      s.attributes.type === t.type &&
      s.attributes.scenario === t.scenario,
    );
    if (!doc) return `[ERROR] Story not found for target: ${t.subject} | ${t.type} | ${t.scenario}`;
    return `Story ${doc.id}:\nTitle: ${doc.title}\nAttributes: ${doc.attributes.subject} | ${doc.attributes.type} | ${doc.attributes.scenario}\nNarrative:\n${doc.narrative}\n\nProposed update: ${a.updatedContent ?? "(empty)"}`;
  }).join("\n\n---\n\n");

  const systemPrompt = [
    "你是 story 更新确认助手。审查提议的 story 更新，确认或修正内容。 /no_think",
    "",
    "输出 JSON:",
    '{"actions":[{"action":"update","target":{"subject":"...","type":"...","scenario":"..."},"updatedContent":"...","append":true/false}]}',
    "",
    "规则:",
    "- updatedContent 是 2-3 句叙事摘要，不要复制原文",
    "- append=true 表示追加到现有叙事，append=false 表示替换",
    "- 可以修正 target 维度如果匹配有误",
  ].join("\n");

  const prompt = [
    "确认或修正以下 story 更新。",
    "",
    storyDetails,
    "",
    "输出确认后的更新 JSON。",
  ].join("\n");

  try {
    const output = await summarizer.rawGenerate(systemPrompt, prompt, 800);
    const parsed = parseBOutput(output);
    if (!parsed) {
      return { success: false, error: "Round 2: JSON parse failed" };
    }
    return { success: true, confirmed: parsed.actions.filter(a => a.action === "update") };
  } catch (err) {
    return {
      success: false,
      error: `Round 2 error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function executeBActions(deps: InnerTurnDeps, actions: InnerTurnBAction[]): BResult {
  const { storyManager, currentTurn, activeStoryTTL, maxActiveStories } = deps;
  let createdCount = 0;
  let updatedCount = 0;
  const created: string[] = [];

  try {
    for (const action of actions) {
      if (action.action === "skip") continue;

      if (action.action === "create" && action.story) {
        const id = storyManager.createStoryDirect({
          subject: action.story.subject,
          type: action.story.type,
          scenario: action.story.scenario,
          content: action.story.content,
        }, currentTurn, activeStoryTTL);
        created.push(id);
        createdCount++;
      } else if (action.action === "update" && action.target && action.updatedContent) {
        const doc = storyManager.findStoryByDimensions(action.target);
        if (!doc) throw new Error(`Story not found for target: ${action.target.subject} | ${action.target.type} | ${action.target.scenario}`);
        storyManager.updateStoryContentDirect(
          doc.id,
          action.updatedContent,
          action.append ?? true,
          currentTurn,
          activeStoryTTL,
        );
        updatedCount++;
      } else {
        throw new Error(`Invalid action: ${JSON.stringify(action)}`);
      }
    }

    // Enforce maxActiveStories — evict oldest if over limit
    storyManager.evictOverflow(maxActiveStories, currentTurn);

    return { success: true, createdCount, updatedCount };
  } catch (err) {
    // Rollback created stories
    for (const id of created) {
      storyManager.removeStory(id);
    }
    return {
      success: false,
      createdCount: 0,
      updatedCount: 0,
      error: `Action execution failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── InnerTurnA ──────────────────────────────────────────────────

async function runInnerTurnA(
  deps: InnerTurnDeps,
  bError: string,
  previousAError: string,
): Promise<boolean> {
  const { summarizer } = deps;
  const samples = deps.sampleRawCleaned();
  const currentRules = deps.currentFilters();

  const retryHint = previousAError
    ? `[重试] 上次执行失败。错误: ${previousAError}。请简化输出，确保有效 JSON。\n\n`
    : "";

  const rulesStr = currentRules.map((r, i) =>
    `[${i}] ${r.match} / ${r.pattern} / ${r.granularity}${r.caseSensitive ? " (case-sensitive)" : ""}`
  ).join("\n") || "(none)";

  const rawStr = samples.map((s, i) => `[${i}] ${s.raw}`).join("\n");
  const cleanedStr = samples.map((s, i) => `[${i}] ${s.cleaned}`).join("\n");

  const prompt = [
    retryHint,
    "## 任务",
    "Story 管理执行失败，分析原因并优化过滤规则。",
    "",
    "## 失败信息",
    bError,
    "",
    "## 当前过滤规则",
    rulesStr,
    "",
    "## 原始数据（过滤前）",
    rawStr,
    "",
    "## 过滤后数据（当前规则效果）",
    cleanedStr,
    "",
    '输出修改后的完整规则组 JSON: {"rules":[...],"reason":"..."}',
  ].join("\n");

  try {
    const output = await summarizer.rawGenerate(INNER_TURN_A_SYSTEM_PROMPT, prompt, 500);
    const parsed = parseAOutput(output);
    if (!parsed || !parsed.rules) return false;

    deps.applyFilterRules(parsed.rules);
    return true;
  } catch {
    return false;
  }
}

// ── JSON Parsers ────────────────────────────────────────────────

function parseBOutput(raw: string): InnerTurnBOutput | null {
  try {
    let text = raw.trim().replace(/```(?:json)?\s*\n?/gi, "").trim();
    const arrMatch = text.match(/\{[\s\S]*\}/);
    if (!arrMatch) return null;

    const parsed = JSON.parse(arrMatch[0]);
    if (!parsed.actions || !Array.isArray(parsed.actions)) return null;

    return { actions: parsed.actions };
  } catch {
    return null;
  }
}

function parseAOutput(raw: string): InnerTurnAResult | null {
  try {
    let text = raw.trim().replace(/```(?:json)?\s*\n?/gi, "").trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;

    return JSON.parse(match[0]) as InnerTurnAResult;
  } catch {
    return null;
  }
}

// ── Dimension Merge Helpers ────────────────────────────────────

function mergePresets(presets: readonly string[], existing: string[]): string[] {
  const set = new Set([...presets, ...existing]);
  return [...set];
}

function buildDimLine(name: string, values: string[]): string {
  return `${name}: {${values.join(", ")}}`;
}

// ── Message Sampling Helpers ────────────────────────────────────

export function sampleMessagesText(messages: unknown[], limit: number): string {
  const recent = messages.slice(-limit);
  return recent
    .map((m) => {
      const role = extractRole(m);
      const text = extractText(m);
      if (!text) return null;
      const summary = text.replace(/\n/g, " ").slice(0, 200);
      return `[${role}]: ${summary}`;
    })
    .filter(Boolean)
    .join("\n");
}
