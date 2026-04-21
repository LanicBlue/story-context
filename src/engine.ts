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
import { resolveConfig, CHARS_PER_TOKEN } from "./config.js";
import type { SessionState, SmartContextConfig, Summarizer } from "./types.js";
import { ContentProcessor } from "./content-processor.js";
import { ContentStorage } from "./content-storage.js";
import { Compactor, extractText as compactorExtractText } from "./compactor.js";
import { extractEventsStructural } from "./event-extractor.js";
import { EventIndexManager } from "./event-index.js";
import { EventStorage } from "./event-storage.js";
import type { EventSummary, EventDocument, EntityDocument } from "./event-types.js";

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
  private readonly eventStorage: EventStorage;

  constructor(config: Record<string, unknown> = {}, summarizer?: Summarizer) {
    this.config = resolveConfig(config);
    this.summarizer = summarizer;
    this.storage = new ContentStorage(this.config.storageDir || undefined);
    this.eventStorage = new EventStorage(this.storage);
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
        focusedEventId: null,
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

    if (role === "toolResult") {
      this.updateSeenReads(s, processedMessage, idx);
    }

    return { ingested: true };
  }

  private updateSeenReads(s: SessionState, message: unknown, idx: number): void {
    if (!this.config.dedupReads) return;

    const toolName = extractToolName(message);
    const filePath = extractToolArg(message, "path");

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

  // ── Event Focus ─────────────────────────────────────────────────

  /** Set the focused event for a session (tool-call or explicit). */
  focusEvent(sessionId: string, eventId: string): void {
    const s = this.state(sessionId);
    s.focusedEventId = eventId;
  }

  /** Clear focus, returning to auto-detect mode. */
  unfocusEvent(sessionId: string): void {
    const s = this.state(sessionId);
    s.focusedEventId = null;
  }

  /** Resolve the current focus event: explicit > auto-detect > none. */
  private resolveFocusEvent(sessionId: string): EventDocument | undefined {
    let mgr: EventIndexManager;
    try {
      mgr = this.getEventManager(sessionId);
    } catch {
      return undefined;
    }

    const s = this.state(sessionId);

    // Explicit focus
    if (s.focusedEventId) {
      const doc = mgr.getAllEvents().find((e) => e.id === s.focusedEventId);
      if (doc) return doc;
    }

    // Auto-detect: most recently updated active event
    const active = mgr.getActiveEvents();
    if (active.length > 0) return active[0];

    // Fallback: most recently updated completed event
    const all = mgr.getAllEvents()
      .filter((e) => e.status !== "active")
      .sort((a, b) => b.lastUpdated - a.lastUpdated);
    return all[0];
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
    }

    const systemParts: string[] = [];

    // Layer 1: Focus event + entity descriptions
    const focusContext = await this.buildFocusEventContext(params.sessionId);
    if (focusContext) systemParts.push(focusContext);

    // Layer 2: Recent events
    const recentEvents = await this.buildRecentEvents(params.sessionId);
    if (recentEvents) systemParts.push(recentEvents);

    const estimatedTokens = Math.ceil(
      (totalChars + systemParts.join("\n").length) / CHARS_PER_TOKEN,
    );

    return {
      messages: selected,
      estimatedTokens,
      systemPromptAddition: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    };
  }

  /** Build Layer 1: focus event full detail + entity descriptions. */
  private async buildFocusEventContext(sessionId: string): Promise<string | undefined> {
    const focusEvent = this.resolveFocusEvent(sessionId);
    if (!focusEvent) return undefined;

    let mgr: EventIndexManager;
    try {
      mgr = this.getEventManager(sessionId);
    } catch {
      return undefined;
    }

    const parts: string[] = [];
    parts.push(`## Current Focus: [[${focusEvent.id}]] ${focusEvent.title}`);
    parts.push("");
    parts.push("### Attributes");
    parts.push(`- Subject: [[subject:${focusEvent.attributes.subject}]]`);
    parts.push(`- Type: [[type:${focusEvent.attributes.type}]]`);
    parts.push(`- Scenario: [[scenario:${focusEvent.attributes.scenario}]]`);
    parts.push("");
    parts.push(`### Status: ${focusEvent.status}`);
    parts.push("");
    parts.push("### Narrative (full)");
    parts.push(focusEvent.narrative.slice(-2000));

    // Extract task/files/operations from linked summaries
    const summaryDetails = await this.extractSummaryDetails(sessionId, focusEvent);
    if (summaryDetails.task) {
      parts.push("", "### Task");
      for (const line of summaryDetails.task.split("\n")) {
        if (line.trim()) parts.push(`- ${line.trim().replace(/^-\s*/, "")}`);
      }
    }
    if (summaryDetails.files.length > 0) {
      parts.push("", "### Files");
      for (const f of summaryDetails.files) {
        parts.push(`- ${f}`);
      }
    }
    if (summaryDetails.operations.length > 0) {
      parts.push("", "### Recent Operations");
      parts.push("| Operation | Target | Result |");
      parts.push("|------|------|------|");
      for (const op of summaryDetails.operations.slice(-10)) {
        parts.push(`| ${op.op} | ${op.target} | ${op.result} |`);
      }
    }

    // Sources
    if (focusEvent.sources.length > 0) {
      parts.push("", "### Sources");
      for (const src of focusEvent.sources) {
        parts.push(`- ${src.summaryPath} (msg ${src.messageRange[0]}-${src.messageRange[1]})`);
      }
    }

    // Entity descriptions
    const entityParts = await this.buildEntityDescriptions(mgr, focusEvent);
    if (entityParts) {
      parts.push("", "## Entity Context");
      parts.push(entityParts);
    }

    return parts.join("\n");
  }

  /** Extract task/files/operations from summary files linked to an event. */
  private async extractSummaryDetails(
    sessionId: string,
    event: EventDocument,
  ): Promise<{ task: string; files: string[]; operations: Array<{ op: string; target: string; result: string }> }> {
    const result = { task: "", files: [] as string[], operations: [] as Array<{ op: string; target: string; result: string }> };

    for (const src of event.sources.slice(-3)) {
      const partials = await this.eventStorage.readSummaryPartials(sessionId, src.summaryPath);
      if (partials.task && !result.task) {
        result.task = partials.task;
      }
      for (const f of partials.files) {
        if (!result.files.includes(f)) result.files.push(f);
      }
      result.operations.push(...partials.operations);
    }

    return result;
  }

  /** Build entity descriptions for the focus event's three dimensions. */
  private async buildEntityDescriptions(
    mgr: EventIndexManager,
    event: EventDocument,
  ): Promise<string | undefined> {
    const dims: Array<["subject" | "type" | "scenario", string]> = [
      ["subject", event.attributes.subject],
      ["type", event.attributes.type],
      ["scenario", event.attributes.scenario],
    ];

    const parts: string[] = [];
    for (const [dim, name] of dims) {
      const entity = mgr.getEntity(dim, name);
      if (entity && entity.description) {
        parts.push(`### ${dim.charAt(0).toUpperCase() + dim.slice(1)}: ${name}`);
        parts.push(entity.description);
      }
    }

    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  /** Build Layer 2: recent event summaries. */
  private async buildRecentEvents(sessionId: string): Promise<string | undefined> {
    let mgr: EventIndexManager;
    try {
      mgr = this.getEventManager(sessionId);
    } catch {
      return undefined;
    }

    const allEvents = mgr.getAllEvents();
    if (allEvents.length === 0) return undefined;

    const focusEvent = this.resolveFocusEvent(sessionId);
    const recentCount = this.config.recentEventCount;

    // Sort by lastUpdated, exclude focus event
    const recent = allEvents
      .filter((e) => !focusEvent || e.id !== focusEvent.id)
      .sort((a, b) => b.lastUpdated - a.lastUpdated)
      .slice(0, recentCount);

    if (recent.length === 0) return undefined;

    const parts: string[] = ["## Recent Events"];
    for (const evt of recent) {
      const narrativeTail = evt.narrative.slice(-500);
      const sourcesStr = evt.sources
        .slice(-2)
        .map((s) => s.summaryPath)
        .join(", ");
      parts.push("");
      parts.push(`- [[${evt.id}]] ${evt.title} (${evt.status})`);
      parts.push(`  ${this.clip(narrativeTail.replace(/\n/g, " "), 200)}`);
      if (sourcesStr) {
        parts.push(`  Sources: ${sourcesStr}`);
      }
    }

    return parts.join("\n");
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
    const budgetChars = params.tokenBudget
      ? params.tokenBudget * CHARS_PER_TOKEN
      : this.config.maxHistoryTokens * CHARS_PER_TOKEN;

    let totalChars = this.totalActiveChars(s);

    if (totalChars <= budgetChars && !params.force) {
      return { ok: true, compacted: false, reason: "within budget" };
    }

    const tokensBefore = Math.ceil(totalChars / CHARS_PER_TOKEN);
    const eventMgr = this.getEventManager(params.sessionId);

    const coreChars = this.config.compactCoreTokens * CHARS_PER_TOKEN;
    const overlapChars = this.config.compactOverlapTokens * CHARS_PER_TOKEN;

    // Compress windows until within budget
    while (totalChars > budgetChars) {
      if (s.activeEnd >= s.messages.length) break; // All compressed

      const window = this.compactor.buildWindow(
        s.messages,
        s.activeEnd,
        { coreChars, overlapChars },
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
      const eventSummaries = extractEventsStructural(
        window.coreMessages,
        compressed.storagePath,
        [window.coreStartIdx, window.coreEndIdx],
      );

      // Process events through the index
      if (eventSummaries.length > 0) {
        await eventMgr.processSummaries(eventSummaries);

        // Update active events list
        s.activeEvents = eventMgr.getActiveEvents().map((e) => e.id);
      }

      totalChars = this.totalActiveChars(s);
    }

    const tokensAfter = Math.ceil(totalChars / CHARS_PER_TOKEN);

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
