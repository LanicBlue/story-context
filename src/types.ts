import type { EventIndex } from "./event-types.js";

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
  memory: {
    task: string;
    files: string[];
    notes: string[];
  };
  seenReads: Map<string, number>; // path -> message index
  /** Event index for this session. */
  eventIndex?: EventIndex;
  /** IDs of events that are likely still in progress. */
  activeEvents: string[];
};

/** LLM summarizer interface used by compact(). */
export type Summarizer = {
  summarize(text: string, targetTokens: number): Promise<string>;
};

/** Plugin configuration resolved from openclaw.plugin.json. */
export type SmartContextConfig = {
  maxHistoryChars: number;
  dedupReads: boolean;
  memoryNotesLimit: number;
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
  outlineHeadLines: number;
  outlineTailLines: number;
  outlineMaxSections: number;
  storageDir: string;
  outlineSummaryEnabled: boolean;
  contentFilters: Array<{
    match: "contains" | "regex";
    pattern: string;
    caseSensitive?: boolean;
    granularity: "message" | "block" | "line";
  }>;
  // Compaction
  compactCoreChars: number;
  compactOverlapChars: number;
  // Session filtering
  sessionFilter: "all" | "main" | string[];
};
