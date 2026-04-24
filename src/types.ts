import type { StoryIndex } from "./story-types.js";

/** A compressed window of conversation content stored on disk. */
export type CompressedWindow = {
  /** Storage-relative path to the .md summary file. */
  storagePath: string;
  /** Core message range [startIdx, endIdx) in session.messages. */
  messageRange: [number, number];
  /** Character count of the core content before compression. */
  originalChars: number;
  /** Character count of the compressed summary. */
  compressedChars: number;
  /** Unix timestamp when compressed. */
  timestamp: number;
};

/** Per-session state tracked by SmartContextEngine. */
export type SessionState = {
  messages: unknown[];
  compressedWindows: CompressedWindow[];
  /** Messages in [0, activeEnd) have been compressed to disk. */
  activeEnd: number;
  /** Story-focus state: null means auto-detect mode. */
  focusedStoryId: string | null;
  seenReads: Map<string, number>; // path -> message index
  /** Story index for this session. */
  storyIndex?: StoryIndex;
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
};

/** LLM summarizer interface used by compact(). */
export type Summarizer = {
  summarize(text: string, targetTokens: number): Promise<string>;
  /** Send a raw prompt (no wrapping) with a custom system prompt. */
  rawGenerate(systemPrompt: string, userPrompt: string, maxTokens: number): Promise<string>;
};

/** Plugin configuration resolved from openclaw.plugin.json. */
export type SmartContextConfig = {
  // Token-based budgets (internally converted to chars × 4)
  maxHistoryTokens: number;
  compactCoreTokens: number;
  compactOverlapTokens: number;
  dedupReads: boolean;
  recentWindowSize: number;
  // Summarization
  summaryEnabled: boolean;
  summaryMode: "runtime" | "http";
  summaryBaseUrl: string;
  summaryModel: string;
  summaryApiKey?: string;
  summaryTargetTokens: number;
  summaryTimeoutMs: number;
  summaryCustomInstructions?: string;
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
  recentStoryCount: number;
  recentSummaryCount: number;
  // Inner turn
  innerTurnInterval: number;
  maxActiveStories: number;
  activeStoryTTL: number;
  recentMessageCount: number;
  innerTurnMessageSample: number;
  // Embedding
  embeddingModel: string;
  embeddingThreshold: number;
  // Session filtering
  sessionFilter: "all" | "main" | string[];
};
