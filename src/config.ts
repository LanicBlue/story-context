import type { SmartContextConfig } from "./types.js";

/** Chars per token for budget estimation (no tokenizer needed). */
export const CHARS_PER_TOKEN = 4;

const DEFAULTS: SmartContextConfig = {
  maxHistoryTokens: 16_000,
  dedupReads: true,
  recentWindowSize: 6,
  summaryEnabled: false,
  summaryMode: "runtime",
  summaryBaseUrl: "http://localhost:11434/v1",
  summaryModel: "",
  summaryTargetTokens: 600,
  summaryTimeoutMs: 30_000,
  largeTextThreshold: 2000,
  storageDir: "",
  contentFilters: [],
  compactCoreTokens: 6000,
  compactOverlapTokens: 1000,
  recentStoryCount: 10,
  recentSummaryCount: 3,
  innerTurnInterval: 20,
  maxActiveStories: 10,
  activeStoryTTL: 40,
  recentMessageCount: 30,
  innerTurnMessageSample: 30,
  sessionFilter: "main",
};

export function resolveConfig(
  raw: Record<string, unknown> | undefined,
): SmartContextConfig {
  const src = raw ?? {};
  return {
    maxHistoryTokens: positiveInt(src.maxHistoryTokens, DEFAULTS.maxHistoryTokens),
    dedupReads: src.dedupReads !== false,
    recentWindowSize: positiveInt(src.recentWindowSize, DEFAULTS.recentWindowSize),
    summaryEnabled: src.summaryEnabled === true || src.outlineSummaryEnabled === true,
    summaryMode: src.summaryMode === "http" ? "http" : "runtime",
    summaryBaseUrl: typeof src.summaryBaseUrl === "string" ? src.summaryBaseUrl : DEFAULTS.summaryBaseUrl,
    summaryModel: typeof src.summaryModel === "string" ? src.summaryModel : DEFAULTS.summaryModel,
    summaryApiKey: typeof src.summaryApiKey === "string" ? src.summaryApiKey : undefined,
    summaryTargetTokens: positiveInt(src.summaryTargetTokens, DEFAULTS.summaryTargetTokens),
    summaryTimeoutMs: positiveInt(src.summaryTimeoutMs, DEFAULTS.summaryTimeoutMs),
    summaryCustomInstructions: typeof src.summaryCustomInstructions === "string"
      ? src.summaryCustomInstructions
      : undefined,
    largeTextThreshold: positiveInt(src.largeTextThreshold, DEFAULTS.largeTextThreshold),
    storageDir: typeof src.storageDir === "string" ? src.storageDir : DEFAULTS.storageDir,
    contentFilters: parseContentFilters(src.contentFilters),
    compactCoreTokens: positiveInt(src.compactCoreTokens, DEFAULTS.compactCoreTokens),
    compactOverlapTokens: positiveInt(src.compactOverlapTokens, DEFAULTS.compactOverlapTokens),
    recentStoryCount: positiveInt(src.recentStoryCount, DEFAULTS.recentStoryCount),
    recentSummaryCount: positiveInt(src.recentSummaryCount, DEFAULTS.recentSummaryCount),
    innerTurnInterval: positiveInt(src.innerTurnInterval, DEFAULTS.innerTurnInterval),
    maxActiveStories: positiveInt(src.maxActiveStories, DEFAULTS.maxActiveStories),
    activeStoryTTL: positiveInt(src.activeStoryTTL, DEFAULTS.activeStoryTTL),
    recentMessageCount: positiveInt(src.recentMessageCount, DEFAULTS.recentMessageCount),
    innerTurnMessageSample: positiveInt(src.innerTurnMessageSample, DEFAULTS.innerTurnMessageSample),
    sessionFilter: parseSessionFilter(src.sessionFilter),
  };
}

function parseContentFilters(value: unknown): SmartContextConfig["contentFilters"] {
  if (!Array.isArray(value)) return [];
  const result: SmartContextConfig["contentFilters"] = [];
  for (const item of value) {
    if (item && typeof item === "object") {
      const r = item as Record<string, unknown>;
      if (
        (r.match === "contains" || r.match === "regex") &&
        typeof r.pattern === "string" &&
        (r.granularity === "message" || r.granularity === "block" || r.granularity === "line")
      ) {
        result.push({
          match: r.match,
          pattern: r.pattern,
          caseSensitive: r.caseSensitive === true,
          granularity: r.granularity,
        });
      }
    }
  }
  return result;
}

function parseSessionFilter(value: unknown): SmartContextConfig["sessionFilter"] {
  if (value === "all") return "all";
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  return "main";
}

function positiveInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
