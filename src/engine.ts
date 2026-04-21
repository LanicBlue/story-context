// ContextEngine types — openclaw exposes these via the plugin-sdk surface.
export type AssembleResult = {
  messages: unknown[];
  estimatedTokens: number;
  systemPromptAddition?: string;
};

export type CompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    summary?: string;
    firstKeptEntryId?: string;
    tokensBefore: number;
    tokensAfter?: number;
    details?: unknown;
  };
};

export type BootstrapResult = {
  bootstrapped: boolean;
  importedMessages?: number;
  reason?: string;
};

export type IngestResult = {
  ingested: boolean;
};

export type ContextEngineInfo = {
  id: string;
  name: string;
  version?: string;
  ownsCompaction?: boolean;
  turnMaintenanceMode?: "foreground" | "background";
};
import { resolveConfig } from "./config.js";
import type { SessionState, SmartContextConfig, Summarizer } from "./types.js";
import { ContentProcessor } from "./content-processor.js";
import { ContentStorage } from "./content-storage.js";
import { Compactor, extractText as compactorExtractText } from "./compactor.js";
import { parseEventOrientedOutput, extractEventsStructural } from "./event-extractor.js";
import { EventIndexManager } from "./event-index.js";
import { EventStorage } from "./event-storage.js";
import type { EventSummary } from "./event-types.js";

export class SmartContextEngine {
  readonly info: ContextEngineInfo = {
    id: "smart-context",
    name: "Smart Context Engine",
    version: "2.0.0",
    ownsCompaction: true,
  };

  private readonly config: SmartContextConfig;
  private readonly sessions = new Map<string, SessionState>();
  private readonly summarizer?: Summarizer;
  private readonly contentProcessor: ContentProcessor;
  private readonly storage: ContentStorage;
  private readonly compactor: Compactor;
  private readonly eventManagers = new Map<string, EventIndexManager>();

  constructor(config: Record<string, unknown> = {}, summarizer?: Summarizer) {
    this.config = resolveConfig(config);
    this.summarizer = summarizer;
    this.storage = new ContentStorage(this.config.storageDir || undefined);
    this.contentProcessor = new ContentProcessor(
      {
        largeTextThreshold: this.config.largeTextThreshold,
        outlineHeadLines: this.config.outlineHeadLines,
        outlineTailLines: this.config.outlineTailLines,
        outlineMaxSections: this.config.outlineMaxSections,
        contentFilters: this.config.contentFilters,
        outlineSummaryEnabled: this.config.outlineSummaryEnabled,
      },
      this.storage,
      summarizer,
    );
    this.compactor = new Compactor(this.storage, summarizer);
  }

  // ── Session helpers ─────────────────────────────────────────────

  private state(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        messages: [],
        compressedWindows: [],
        activeEnd: 0,
        memory: { task: "", files: [], notes: [] },
        seenReads: new Map(),
        eventIndex: {
          documents: new Map(),
          entities: new Map(),
          processedSummaries: new Set(),
        },
        activeEvents: [],
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  /** Check if a session should be processed based on sessionKey and config. */
  private shouldProcess(sessionKey?: string): boolean {
    const filter = this.config.sessionFilter;
    if (filter === "all") return true;
    if (!sessionKey) return true; // No key provided — allow (e.g. testing)

    if (filter === "main") {
      // Main session keys look like: agent:{agentId}:main
      // or without :main suffix for the default agent
      return isMainSessionKey(sessionKey);
    }

    // Array of regex patterns
    if (Array.isArray(filter)) {
      return filter.some((pattern) => new RegExp(pattern).test(sessionKey));
    }

    return true;
  }

  private clip(text: string, limit: number): string {
    if (text.length <= limit) return text;
    return text.slice(0, limit) + `\n...[truncated ${text.length - limit} chars]`;
  }

  private activeMessages(s: SessionState): unknown[] {
    return s.messages.slice(s.activeEnd);
  }

  private totalActiveChars(s: SessionState): number {
    return this.activeMessages(s).reduce(
      (sum: number, msg) => sum + extractText(msg).length,
      0,
    );
  }

  private getEventManager(sessionId: string): EventIndexManager {
    let mgr = this.eventManagers.get(sessionId);
    if (!mgr) {
      const dbPath = this.storage.resolvePath(sessionId, "index.db");
      const eventStorage = this.compactor.getEventStorage();
      mgr = new EventIndexManager(dbPath, eventStorage, sessionId, this.summarizer);
      this.eventManagers.set(sessionId, mgr);
    }
    return mgr;
  }

  // ── ingest ──────────────────────────────────────────────────────

  async ingest(params: {
    sessionId: string;
    sessionKey?: string;
    message: unknown;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    if (!this.shouldProcess(params.sessionKey)) {
      return { ingested: true };
    }
    const s = this.state(params.sessionId);

    const processed = await this.contentProcessor.processContent(
      (params.message as { content?: unknown }).content,
      params.sessionId,
    );

    if (processed.dropMessage) {
      return { ingested: true };
    }

    const idx = s.messages.length;
    const processedMessage = {
      ...(params.message as Record<string, unknown>),
      content: processed.contextText,
    };
    s.messages.push(processedMessage);

    const role = extractRole(params.message);
    if (role === "user" && !s.memory.task) {
      s.memory.task = this.clip(extractText(params.message), 300);
    }

    if (role === "toolResult") {
      this.updateToolMemory(s, processedMessage, idx);
    }

    return { ingested: true };
  }

  private updateToolMemory(s: SessionState, message: unknown, idx: number): void {
    const toolName = extractToolName(message);
    const filePath = extractToolArg(message, "path");

    if (this.config.dedupReads) {
      if (toolName === "read_file" && filePath) {
        s.seenReads.set(filePath, idx);
      }
      if (
        (toolName === "write_file" || toolName === "patch_file") &&
        filePath
      ) {
        s.seenReads.delete(filePath);
      }
    }

    if (filePath && (toolName === "read_file" || toolName === "write_file" || toolName === "patch_file")) {
      this.remember(s.memory.files, filePath, 8);
    }

    const text = extractText(message).replace(/\n/g, " ");
    const note = `${toolName}: ${this.clip(text, 220)}`;
    this.remember(s.memory.notes, note, this.config.memoryNotesLimit);
  }

  private remember(bucket: string[], item: string, limit: number): void {
    const idx = bucket.indexOf(item);
    if (idx !== -1) bucket.splice(idx, 1);
    bucket.push(item);
    if (bucket.length > limit) bucket.splice(0, bucket.length - limit);
  }

  // ── assemble ────────────────────────────────────────────────────

  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: unknown[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    if (!this.shouldProcess(params.sessionKey)) {
      return { messages: params.messages, estimatedTokens: 0 };
    }
    const s = this.state(params.sessionId);
    const active = [...this.activeMessages(s), ...params.messages];
    const budget = this.config.maxHistoryChars;
    const recentStart = Math.max(0, active.length - this.config.recentWindowSize);

    const selected: unknown[] = [];
    let totalChars = 0;

    // Dedup and select active messages
    for (let i = 0; i < active.length; i++) {
      const msg = active[i];
      const isRecent = i >= recentStart;

      if (!isRecent && this.config.dedupReads) {
        const toolName = extractToolName(msg);
        if (toolName === "read_file") {
          const filePath = extractToolArg(msg, "path");
          if (filePath && s.seenReads.has(filePath) && s.seenReads.get(filePath) !== i + s.activeEnd) {
            continue;
          }
        }
      }

      selected.push(msg);
      totalChars += extractText(msg).length;

      // Drop oldest if over budget
      while (totalChars > budget && selected.length > 1) {
        const dropped = selected.shift()!;
        totalChars -= extractText(dropped).length;
      }
    }

    const systemParts: string[] = [];

    // Memory prompt
    const memoryPrompt = this.buildMemoryPrompt(s);
    if (memoryPrompt) systemParts.push(memoryPrompt);

    // Event context
    const eventContext = this.buildEventContext(params.sessionId);
    if (eventContext) systemParts.push(eventContext);

    // Summary refs (legacy)
    const summaryRefs = this.buildSummaryRefs(s);
    if (summaryRefs) systemParts.push(summaryRefs);

    const estimatedTokens = Math.ceil(
      (totalChars + systemParts.join("\n").length) / 4,
    );

    return {
      messages: selected,
      estimatedTokens,
      systemPromptAddition: systemParts.length > 0 ? systemParts.join("\n") : undefined,
    };
  }

  private buildEventContext(sessionId: string): string | undefined {
    let mgr: EventIndexManager;
    try {
      mgr = this.getEventManager(sessionId);
    } catch {
      return undefined;
    }

    const activeEvents = mgr.getActiveEvents();
    const allEvents = mgr.getAllEvents();
    if (allEvents.length === 0) return undefined;

    const parts: string[] = ["## Events"];

    // Active events with full context
    for (const evt of activeEvents.slice(0, 5)) {
      parts.push("");
      parts.push(`### [[${evt.id}]] ${evt.title}`);
      parts.push(`Status: ${evt.status}`);
      parts.push(
        `Subject: [[subject:${evt.attributes.subject}]] | ` +
        `Type: [[type:${evt.attributes.type}]] | ` +
        `Scenario: [[scenario:${evt.attributes.scenario}]]`,
      );
      parts.push(evt.narrative.slice(-300));
    }

    // Completed events as compact list
    const completed = allEvents.filter((e) => e.status !== "active");
    if (completed.length > 0) {
      parts.push("");
      parts.push("## Completed Events");
      for (const evt of completed.slice(0, 10)) {
        parts.push(`- [[${evt.id}]] ${evt.title} (${evt.status})`);
      }
    }

    return parts.join("\n");
  }

  private buildSummaryRefs(s: SessionState): string | undefined {
    if (s.compressedWindows.length === 0) return undefined;

    const parts: string[] = ["Previous conversation summaries:"];
    for (let i = 0; i < s.compressedWindows.length; i++) {
      const w = s.compressedWindows[i];
      parts.push(`- ${w.storagePath} (${w.originalChars} chars → ${w.compressedChars} chars, messages ${w.messageRange[0]}-${w.messageRange[1] - 1})`);
    }
    return parts.join("\n");
  }

  private buildMemoryPrompt(s: SessionState): string | undefined {
    const parts: string[] = [];

    if (s.memory.task) {
      parts.push(`Current task: ${s.memory.task}`);
    }
    if (s.memory.files.length > 0) {
      parts.push(`Tracked files: ${s.memory.files.join(", ")}`);
    }
    if (s.memory.notes.length > 0) {
      parts.push("Working memory:");
      for (const note of s.memory.notes) {
        parts.push(`- ${note}`);
      }
    }

    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  // ── compact ─────────────────────────────────────────────────────

  async compact(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
  }): Promise<CompactResult> {
    if (!this.shouldProcess(params.sessionKey)) {
      return { ok: true, compacted: false, reason: "session filtered" };
    }
    const s = this.state(params.sessionId);
    const budget = params.tokenBudget
      ? Math.floor(params.tokenBudget * 4)
      : this.config.maxHistoryChars;

    let totalChars = this.totalActiveChars(s);

    if (totalChars <= budget && !params.force) {
      return { ok: true, compacted: false, reason: "within budget" };
    }

    const tokensBefore = Math.ceil(totalChars / 4);
    const eventMgr = this.getEventManager(params.sessionId);

    // Compress windows until within budget
    while (totalChars > budget) {
      if (s.activeEnd >= s.messages.length) break; // All compressed

      const window = this.compactor.buildWindow(
        s.messages,
        s.activeEnd,
        { coreChars: this.config.compactCoreChars, overlapChars: this.config.compactOverlapChars },
      );

      if (window.coreMessages.length === 0) break;

      // Generate summary
      let markdown: string;
      if (this.summarizer) {
        try {
          const coreText = window.coreMessages
            .map((m) => `[${extractRole(m)}]: ${extractText(m)}`)
            .join("\n\n");
          markdown = await this.compactor.compressWithLLM(
            window.preOverlap,
            coreText,
            window.postOverlap,
            this.config.summaryTargetTokens,
          );
        } catch {
          markdown = this.compactor.buildStructuralSummary(window.coreMessages);
        }
      } else {
        markdown = this.compactor.buildStructuralSummary(window.coreMessages);
      }

      // Save summary to disk
      const compressed = await this.compactor.saveSummary(
        params.sessionId,
        markdown,
        [window.coreStartIdx, window.coreEndIdx],
        window.coreTotalChars,
      );

      s.compressedWindows.push(compressed);
      s.activeEnd = window.coreEndIdx;

      // Extract events from the summary
      let eventSummaries: EventSummary[];
      if (this.summarizer) {
        // With LLM: parse the compressed output for events
        eventSummaries = extractEventsStructural(
          window.coreMessages,
          compressed.storagePath,
          [window.coreStartIdx, window.coreEndIdx],
        );
      } else {
        eventSummaries = extractEventsStructural(
          window.coreMessages,
          compressed.storagePath,
          [window.coreStartIdx, window.coreEndIdx],
        );
      }

      // Process events through the index
      if (eventSummaries.length > 0) {
        await eventMgr.processSummaries(eventSummaries);

        // Update active events list
        s.activeEvents = eventMgr.getActiveEvents().map((e) => e.id);
      }

      totalChars = this.totalActiveChars(s);
    }

    const tokensAfter = Math.ceil(totalChars / 4);

    if (!params.force && totalChars <= budget) {
      return {
        ok: true,
        compacted: true,
        result: { tokensBefore, tokensAfter },
      };
    }

    return {
      ok: true,
      compacted: true,
      result: { tokensBefore, tokensAfter },
    };
  }

  // ── bootstrap ───────────────────────────────────────────────────

  async bootstrap(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
  }): Promise<BootstrapResult> {
    return { bootstrapped: true, importedMessages: 0, reason: "memory-only engine" };
  }

  // ── dispose ─────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    // Close SQLite databases first (before cleanup deletes files)
    for (const mgr of this.eventManagers.values()) {
      mgr.close();
    }
    this.eventManagers.clear();

    for (const sessionId of this.sessions.keys()) {
      await this.contentProcessor.cleanupSession(sessionId);
    }
    this.sessions.clear();
  }

  // ── Test helper ─────────────────────────────────────────────────

  /** @internal Exposed for testing only. */
  _getState(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }
}

// ── Message extraction helpers ─────────────────────────────────────

function extractRole(msg: unknown): string {
  return (msg as { role?: string }).role ?? "unknown";
}

function extractText(msg: unknown): string {
  return compactorExtractText(msg);
}

function extractToolName(msg: unknown): string {
  return (msg as { toolName?: string }).toolName ?? "";
}

function extractToolArg(msg: unknown, key: string): string {
  const args = (msg as { args?: Record<string, unknown> }).args;
  if (args && typeof args === "object") {
    const val = args[key];
    return typeof val === "string" ? val : "";
  }
  return "";
}

// ── Session key helpers ─────────────────────────────────────────────

/** Determine if a sessionKey corresponds to a main session.
 *  Main session keys: agent:{agentId}:main or agent:main:main
 *  Non-main examples: agent:main:slack:workspace:direct:user123
 */
function isMainSessionKey(sessionKey: string): boolean {
  const parts = sessionKey.split(":");
  if (parts.length < 2) return true; // Unknown format — allow
  if (parts.length === 3 && parts[2] === "main") return true;
  if (parts.length === 2 && parts[0] === "agent") return true;
  return false;
}
