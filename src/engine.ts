import { resolveConfig, CHARS_PER_TOKEN } from "./config.js";
import type { SessionState, SmartContextConfig, Summarizer } from "./types.js";
import { ContentProcessor } from "./content-processor.js";
import { ContentStorage } from "./content-storage.js";
import { Compactor, extractText as compactorExtractText } from "./compactor.js";
import { extractEventsStructural, extractEventsWithLLM } from "./event-extractor.js";
import { EventIndexManager } from "./event-index.js";
import { EventStorage } from "./event-storage.js";
import { MessageStore } from "./message-store.js";
import type { EventSummary, EventDocument, EntityDocument } from "./event-types.js";

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

export class SmartContextEngine {
  readonly info: ContextEngineInfo = {
    id: "smart-context",
    name: "Smart Context Engine",
    version: "2.0.0",
    ownsCompaction: true,
    turnMaintenanceMode: "foreground",
  };

  private readonly config: SmartContextConfig;
  private readonly sessions = new Map<string, SessionState>();
  private readonly summarizer?: Summarizer;
  private readonly contentProcessor: ContentProcessor;
  private readonly storage: ContentStorage;
  private readonly compactor: Compactor;
  private readonly eventManagers = new Map<string, EventIndexManager>();
  private readonly eventStorage: EventStorage;
  private readonly messageStore: MessageStore;

  constructor(config: Record<string, unknown> = {}, summarizer?: Summarizer) {
    this.config = resolveConfig(config);
    this.summarizer = summarizer;
    this.storage = new ContentStorage(this.config.storageDir || undefined);
    this.eventStorage = new EventStorage(this.storage);
    this.contentProcessor = new ContentProcessor(
      {
        largeTextThreshold: this.config.largeTextThreshold,
        contentFilters: this.config.contentFilters,
        summaryEnabled: this.config.summaryEnabled,
      },
      this.storage,
      summarizer,
    );
    this.compactor = new Compactor(this.storage, summarizer);
    this.messageStore = new MessageStore(this.config.storageDir || "");
  }

  // ── Session helpers ─────────────────────────────────────────────

  private state(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      // Try loading from disk (sync — returns null if not found)
      // Async load is done in bootstrap(); this is a fallback for non-bootstrap paths
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
        lastProcessedIdx: 0,
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  /** Check if a session should be processed based on sessionKey and config. */
  private shouldProcess(sessionKey?: string): boolean {
    const filter = this.config.sessionFilter;
    if (filter === "all") return true;
    if (!sessionKey) return true;

    if (filter === "main") {
      return isMainSessionKey(sessionKey);
    }

    if (Array.isArray(filter)) {
      return filter.some((pattern) => new RegExp(pattern).test(sessionKey));
    }

    return true;
  }

  private clip(text: string, limit: number): string {
    if (text.length <= limit) return text;
    return text.slice(0, limit) + `\n...[truncated ${text.length - limit} chars]`;
  }

  /** Active messages that haven't been compressed yet, excluding dropped. */
  private activeMessages(s: SessionState): unknown[] {
    return s.messages.slice(s.activeEnd).filter((m) => !isDropped(m));
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
      const db = this.messageStore.getDb(sessionId);
      const eventStorage = this.compactor.getEventStorage();
      mgr = new EventIndexManager(db, eventStorage, sessionId, this.summarizer);
      this.eventManagers.set(sessionId, mgr);
    }
    return mgr;
  }

  // ── ingest ──────────────────────────────────────────────────────
  //
  // Only persists large tool outputs to prevent context overflow.
  // All other processing (metadata stripping, filtering, MicroCompact)
  // happens in afterTurn().

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
    const role = extractRole(params.message);
    let content = (params.message as { content?: unknown }).content;

    // Only persist large tool outputs to prevent context overflow.
    // Everything else passes through as-is for the current turn.
    if (role === "toolResult") {
      const persisted = await this.contentProcessor.persistLargeContent(
        content,
        params.sessionId,
      );
      if (persisted !== null) {
        content = persisted;
      }
    }

    const idx = s.messages.length;
    const processedMessage = {
      ...(params.message as Record<string, unknown>),
      content,
    };
    s.messages.push(processedMessage);

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

  // ── afterTurn ───────────────────────────────────────────────────
  //
  // Post-turn processing:
  // 1. Strip platform metadata from user messages
  // 2. Apply content filters (drop NO_REPLY, strip HEARTBEAT, etc.)
  // 3. Persist media and remaining large content
  // 4. MicroCompact: clear old tool results from previous turns

  async afterTurn(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    messages?: unknown[];
    prePromptMessageCount?: number;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: unknown;
  }): Promise<void> {
    if (!this.shouldProcess(params.sessionKey)) return;

    const s = this.state(params.sessionId);
    const turnStart = s.lastProcessedIdx;

    // 1. Process new messages from this turn
    for (let i = turnStart; i < s.messages.length; i++) {
      const msg = s.messages[i] as Record<string, unknown>;
      const role = extractRole(msg);

      // Strip platform metadata from user messages
      if (role === "user" && typeof msg.content === "string") {
        msg.content = stripPlatformMetadata(msg.content);
      }

      // Apply content filters + persist media/large text
      const processed = await this.contentProcessor.processContent(
        msg.content,
        params.sessionId,
      );
      if (processed.dropMessage) {
        msg._dropped = true;
      } else if (processed.contextText !== extractText(msg)) {
        msg.content = processed.contextText;
      }
    }

    // 2. MicroCompact: clear old tool results from previous turns
    for (let i = s.activeEnd; i < turnStart; i++) {
      const msg = s.messages[i] as Record<string, unknown>;
      if (extractRole(msg) === "toolResult" && !isDropped(msg)) {
        const text = typeof msg.content === "string" ? msg.content : "";
        if (text.length > this.config.largeTextThreshold) {
          msg.content = "[Old tool result content cleared]";
        }
      }
    }

    s.lastProcessedIdx = s.messages.length;

    // Persist: write finalized messages to DB (first write for this turn's messages)
    for (let i = turnStart; i < s.messages.length; i++) {
      this.messageStore.upsertMessage(params.sessionId, i, s.messages[i]);
    }
    // Also update MicroCompact'd messages from previous turns
    for (let i = s.activeEnd; i < turnStart; i++) {
      const msg = s.messages[i] as Record<string, unknown>;
      const text = typeof msg.content === "string" ? msg.content : "";
      if (extractRole(msg) === "toolResult" && !isDropped(msg) && text === "[Old tool result content cleared]") {
        this.messageStore.upsertMessage(params.sessionId, i, msg);
      }
    }
    this.messageStore.saveState(params.sessionId, s);
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

    if (s.focusedEventId) {
      const doc = mgr.getAllEvents().find((e) => e.id === s.focusedEventId);
      if (doc) return doc;
    }

    const active = mgr.getActiveEvents();
    if (active.length > 0) return active[0];

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

    const focusContext = await this.buildFocusEventContext(params.sessionId);
    if (focusContext) systemParts.push(focusContext);

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

    if (focusEvent.sources.length > 0) {
      parts.push("", "### Sources");
      for (const src of focusEvent.sources) {
        parts.push(`- ${src.summaryPath} (msg ${src.messageRange[0]}-${src.messageRange[1]})`);
      }
    }

    const entityParts = await this.buildEntityDescriptions(mgr, focusEvent);
    if (entityParts) {
      parts.push("", "## Entity Context");
      parts.push(entityParts);
    }

    return parts.join("\n");
  }

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

    while (totalChars > budgetChars) {
      if (s.activeEnd >= s.messages.length) break;

      const window = this.compactor.buildWindow(
        s.messages,
        s.activeEnd,
        { coreChars, overlapChars },
      );

      if (window.coreMessages.length === 0) break;

      // Skip dropped messages
      const nonDroppedCore = window.coreMessages.filter((m) => !isDropped(m));
      if (nonDroppedCore.length === 0) {
        s.activeEnd = window.coreEndIdx;
        totalChars = this.totalActiveChars(s);
        continue;
      }

      let markdown: string;
      let eventSummaries: EventSummary[];
      const knownDimensions = eventMgr.getKnownDimensions();
      const dims = knownDimensions.subjects.length > 0 ? knownDimensions : undefined;

      if (this.summarizer) {
        const coreText = nonDroppedCore
          .map((m) => `[${extractRole(m)}]: ${extractText(m)}`)
          .join("\n\n");
        try {
          const { rawOutput, events: llmEvents } = await extractEventsWithLLM(
            nonDroppedCore,
            window.preOverlap,
            window.postOverlap,
            this.summarizer,
            "",
            [window.coreStartIdx, window.coreEndIdx],
            dims,
          );
          markdown = rawOutput;
          eventSummaries = llmEvents;
        } catch {
          markdown = this.compactor.buildStructuralSummary(nonDroppedCore);
          eventSummaries = extractEventsStructural(
            nonDroppedCore, "", [window.coreStartIdx, window.coreEndIdx], dims,
          );
        }
      } else {
        markdown = this.compactor.buildStructuralSummary(nonDroppedCore);
        eventSummaries = extractEventsStructural(
          nonDroppedCore, "", [window.coreStartIdx, window.coreEndIdx], dims,
        );
      }

      if (eventSummaries.length === 0 && markdown.trim().length === 0) {
        s.activeEnd = window.coreEndIdx;
        totalChars = this.totalActiveChars(s);
        continue;
      }

      const compressed = await this.compactor.saveSummary(
        params.sessionId,
        markdown,
        [window.coreStartIdx, window.coreEndIdx],
        window.coreTotalChars,
      );

      eventSummaries = eventSummaries.map((e) => ({ ...e, sourceSummary: compressed.storagePath }));

      // Record window range in DB (messages already stored by ingest, no duplication)
      this.messageStore.addWindow(params.sessionId, compressed);

      s.compressedWindows.push(compressed);
      s.activeEnd = window.coreEndIdx;

      if (eventSummaries.length > 0) {
        await eventMgr.processSummaries(eventSummaries);
        s.activeEvents = eventMgr.getActiveEvents().map((e) => e.id);
      }

      totalChars = this.totalActiveChars(s);
    }

    const tokensAfter = Math.ceil(totalChars / CHARS_PER_TOKEN);

    // Persist state after compression
    this.messageStore.saveState(params.sessionId, s);

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
    if (!this.shouldProcess(params.sessionKey)) {
      return { bootstrapped: true, importedMessages: 0, reason: "session filtered" };
    }

    const loaded = this.messageStore.load(params.sessionId);
    if (loaded) {
      this.sessions.set(params.sessionId, loaded);
      return {
        bootstrapped: true,
        importedMessages: loaded.messages.length,
        reason: `restored from disk (${loaded.compressedWindows.length} compressed windows, ${loaded.activeEvents.length} active events)`,
      };
    }

    return { bootstrapped: true, importedMessages: 0, reason: "no saved state" };
  }

  // ── dispose ─────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    // Persist all sessions before shutdown
    for (const [sessionId, s] of this.sessions) {
      try {
        this.messageStore.saveState(sessionId, s);
      } catch {
        // best-effort
      }
    }

    for (const mgr of this.eventManagers.values()) {
      mgr.close();
    }
    this.eventManagers.clear();

    // Close all DBs after event managers are done
    this.messageStore.closeAll();

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

function isDropped(msg: unknown): boolean {
  return (msg as Record<string, unknown>)._dropped === true;
}

/**
 * Strip OpenClaw platform metadata blocks from user message content.
 */
function stripPlatformMetadata(text: string): string {
  let result = text.replace(
    /Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```/g,
    "",
  );
  result = result.replace(
    /Sender \(untrusted metadata\):\s*```json[\s\S]*?```/g,
    "",
  );
  result = result.replace(/^\[message_id:.*\]$/gm, "");
  result = result.replace(/^ou_[a-f0-9]+:\s*/gm, "");
  result = result.replace(/\n{3,}/g, "\n\n").trim();
  return result;
}

// ── Session key helpers ─────────────────────────────────────────────

function isMainSessionKey(sessionKey: string): boolean {
  const parts = sessionKey.split(":");
  if (parts.length < 2) return true;
  if (parts.length === 3 && parts[2] === "main") return true;
  if (parts.length === 2 && parts[0] === "agent") return true;
  return false;
}
