/** Per-session state tracked by SmartContextEngine. */
export type SessionState = {
  messages: unknown[];
  seenReads: Map<string, number>; // path -> message index
  /** IDs of stories that are likely still in progress. */
  activeStories: string[];
  /** Index of first message not yet processed by afterTurn. */
  lastProcessedIdx: number;
  /** Current turn counter (incremented each afterTurn). */
  currentTurn: number;
  /** Turns since last inner turn execution. */
  turnsSinceInnerTurn: number;
  /** Whether an inner turn is currently running. */
  innerTurnRunning: boolean;
  /** Adjusted by compact() when over budget. undefined = use default. */
  adjustedMessageWindowSize?: number;
  adjustedMaxActiveStories?: number;
};

/** LLM interface used by inner turn. */
export type Summarizer = {
  /** Send a raw prompt (no wrapping) with a custom system prompt. */
  rawGenerate(systemPrompt: string, userPrompt: string, maxTokens: number): Promise<string>;
};

/** Plugin configuration resolved from openclaw.plugin.json. */
export type SmartContextConfig = {
  // Token-based budgets (internally converted to chars × 4)
  maxHistoryTokens: number;
  dedupReads: boolean;
  messageWindowSize: number;
  // Content processing
  largeTextThreshold: number;
  storageDir: string;
  contentFilters: Array<{
    match: "contains" | "regex";
    pattern: string;
    caseSensitive?: boolean;
    granularity: "message" | "block" | "line";
  }>;
  // Story context
  fullStoryCount: number;
  summaryStoryCount: number;
  // Inner turn
  innerTurnInterval: number;
  maxActiveStories: number;
  activeStoryTTL: number;
  // LLM service
  llmEnabled: boolean;
  llmMode: "runtime" | "http";
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey?: string;
  llmTimeoutMs: number;
  // Session filtering
  sessionFilter: "all" | "main" | string[];
};
