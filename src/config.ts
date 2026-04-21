import type { SmartContextConfig } from "./types.js";

const DEFAULTS: SmartContextConfig = {
  maxHistoryChars: 12_000,
  dedupReads: true,
  memoryNotesLimit: 5,
  recentWindowSize: 6,
  summaryEnabled: false,
  summaryMode: "runtime",
  summaryBaseUrl: "http://localhost:11434/v1",
  summaryModel: "",
  summaryTargetTokens: 600,
  summaryTimeoutMs: 30_000,
  largeTextThreshold: 2000,
  outlineHeadLines: 8,
  outlineTailLines: 5,
  outlineMaxSections: 20,
  storageDir: "",
  outlineSummaryEnabled: false,
  contentFilters: [],
  compactCoreChars: 6000,
  compactOverlapChars: 1000,
  sessionFilter: "main",
};

export function resolveConfig(
  raw: Record<string, unknown> | undefined,
): SmartContextConfig {
  const src = raw ?? {};
  return {
    maxHistoryChars: positiveInt(src.maxHistoryChars, DEFAULTS.maxHistoryChars),
    dedupReads: src.dedupReads !== false,
    memoryNotesLimit: positiveInt(src.memoryNotesLimit, DEFAULTS.memoryNotesLimit),
    recentWindowSize: positiveInt(src.recentWindowSize, DEFAULTS.recentWindowSize),
    summaryEnabled: src.summaryEnabled === true,
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
    outlineHeadLines: positiveInt(src.outlineHeadLines, DEFAULTS.outlineHeadLines),
    outlineTailLines: positiveInt(src.outlineTailLines, DEFAULTS.outlineTailLines),
    outlineMaxSections: positiveInt(src.outlineMaxSections, DEFAULTS.outlineMaxSections),
    storageDir: typeof src.storageDir === "string" ? src.storageDir : DEFAULTS.storageDir,
    outlineSummaryEnabled: src.outlineSummaryEnabled === true,
    contentFilters: parseContentFilters(src.contentFilters),
    compactCoreChars: positiveInt(src.compactCoreChars, DEFAULTS.compactCoreChars),
    compactOverlapChars: positiveInt(src.compactOverlapChars, DEFAULTS.compactOverlapChars),
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
    // Regex patterns
    return value.filter((v): v is string => typeof v === "string");
  }
  return "main"; // default: only main session
}

function positiveInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
