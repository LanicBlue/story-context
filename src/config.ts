import type { SmartContextConfig } from "./types.js";

/** Chars per token for budget estimation (no tokenizer needed). */
export const CHARS_PER_TOKEN = 4;

const DEFAULTS: SmartContextConfig = {
  maxHistoryTokens: 120_000,
  dedupReads: true,
  messageWindowSize: 30,
  largeTextThreshold: 2000,
  storageDir: "",
  contentFilters: [
    { match: "contains", pattern: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.", granularity: "message" },
    { match: "regex", pattern: "^HEARTBEAT_OK$", caseSensitive: true, granularity: "message" },
  ],
  fullStoryCount: 3,
  innerTurnInterval: 20,
  maxActiveStories: 13,
  activeStoryTTL: 40,
  llmEnabled: false,
  llmMode: "runtime",
  llmBaseUrl: "http://localhost:11434/v1",
  llmModel: "",
  llmTimeoutMs: 30_000,
  sessionFilter: "main",
};

export function resolveConfig(
  raw: Record<string, unknown> | undefined,
): SmartContextConfig {
  const src = raw ?? {};
  return {
    maxHistoryTokens: positiveInt(src.maxHistoryTokens, DEFAULTS.maxHistoryTokens),
    dedupReads: src.dedupReads !== false,
    messageWindowSize: positiveInt(src.messageWindowSize ?? src.recentWindowSize, DEFAULTS.messageWindowSize),
    largeTextThreshold: positiveInt(src.largeTextThreshold, DEFAULTS.largeTextThreshold),
    storageDir: typeof src.storageDir === "string" ? src.storageDir : DEFAULTS.storageDir,
    contentFilters: Array.isArray(src.contentFilters) ? parseContentFilters(src.contentFilters) : DEFAULTS.contentFilters,
    fullStoryCount: positiveInt(src.fullStoryCount, DEFAULTS.fullStoryCount),
    innerTurnInterval: positiveInt(src.innerTurnInterval, DEFAULTS.innerTurnInterval),
    maxActiveStories: positiveInt(src.maxActiveStories, DEFAULTS.maxActiveStories),
    activeStoryTTL: positiveInt(src.activeStoryTTL, DEFAULTS.activeStoryTTL),
    llmEnabled: src.llmEnabled === true || src.summaryEnabled === true,
    llmMode: (src.llmMode ?? src.summaryMode) === "http" ? "http" : "runtime",
    llmBaseUrl: typeof (src.llmBaseUrl ?? src.summaryBaseUrl) === "string" ? (src.llmBaseUrl ?? src.summaryBaseUrl) as string : DEFAULTS.llmBaseUrl,
    llmModel: typeof (src.llmModel ?? src.summaryModel) === "string" ? (src.llmModel ?? src.summaryModel) as string : DEFAULTS.llmModel,
    llmApiKey: typeof (src.llmApiKey ?? src.summaryApiKey) === "string" ? (src.llmApiKey ?? src.summaryApiKey) as string : undefined,
    llmTimeoutMs: positiveInt(src.llmTimeoutMs ?? src.summaryTimeoutMs, DEFAULTS.llmTimeoutMs),
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
