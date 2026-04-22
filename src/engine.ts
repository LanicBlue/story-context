import { resolveConfig, CHARS_PER_TOKEN } from "./config.js";
import type { SessionState, SmartContextConfig, Summarizer } from "./types.js";
import { ContentProcessor } from "./content-processor.js";
import { ContentStorage } from "./content-storage.js";
import { Compactor, extractText as compactorExtractText } from "./compactor.js";
import { extractStoriesStructural, extractStoriesWithLLM } from "./story-extractor.js";
import { StoryIndexManager } from "./story-index.js";
import { StoryStorage } from "./story-storage.js";
import { MessageStore } from "./message-store.js";
import type { StorySummary, StoryDocument, EntityDocument } from "./story-types.js";

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
  private readonly storyManagers = new Map<string, StoryIndexManager>();
  private readonly storyStorage: StoryStorage;
  private readonly messageStore: MessageStore;

  constructor(config: Record<string, unknown> = {}, summarizer?: Summarizer) {
    this.config = resolveConfig(config);
    this.summarizer = summarizer;
    this.storage = new ContentStorage(this.config.storageDir || undefined);
    this.storyStorage = new StoryStorage(this.storage);
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
        focusedStoryId: null,
        seenReads: new Map(),
        storyIndex: {
          documents: new Map(),
          entities: new Map(),
          processedSummaries: new Set(),
        },
        activeStories: [],
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

  private getStoryManager(sessionId: string): StoryIndexManager {
    let mgr = this.storyManagers.get(sessionId);
    if (!mgr) {
      const db = this.messageStore.getDb(sessionId);
      const storyStorage = this.compactor.getStoryStorage();
      mgr = new StoryIndexManager(db, storyStorage, sessionId, this.summarizer);
      this.storyManagers.set(sessionId, mgr);
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

  // ── Story Focus ─────────────────────────────────────────────────

  /** Set the focused story for a session (tool-call or explicit). */
  focusStory(sessionId: string, storyId: string): void {
    const s = this.state(sessionId);
    s.focusedStoryId = storyId;
  }

  /** Clear focus, returning to auto-detect mode. */
  unfocusStory(sessionId: string): void {
    const s = this.state(sessionId);
    s.focusedStoryId = null;
  }

  /** Resolve the current focus story: explicit > auto-detect > none. */
  private resolveFocusStory(sessionId: string): StoryDocument | undefined {
    let mgr: StoryIndexManager;
    try {
      mgr = this.getStoryManager(sessionId);
    } catch {
      return undefined;
    }

    const s = this.state(sessionId);

    if (s.focusedStoryId) {
      const doc = mgr.getAllStories().find((e) => e.id === s.focusedStoryId);
      if (doc) return doc;
    }

    const active = mgr.getActiveStories();
    if (active.length > 0) return active[0];

    const all = mgr.getAllStories()
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

    const focusContext = await this.buildFocusStoryContext(params.sessionId);
    if (focusContext) systemParts.push(focusContext);

    const recentStories = await this.buildRecentStories(params.sessionId);
    if (recentStories) systemParts.push(recentStories);

    const recentSummaries = await this.buildRecentSummaries(params.sessionId, s);
    if (recentSummaries) systemParts.push(recentSummaries);

    const estimatedTokens = Math.ceil(
      (totalChars + systemParts.join("\n").length) / CHARS_PER_TOKEN,
    );

    return {
      messages: selected,
      estimatedTokens,
      systemPromptAddition: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    };
  }

  /** Build Layer 1: focus story full detail + entity descriptions. */
  private async buildFocusStoryContext(sessionId: string): Promise<string | undefined> {
    const focusStory = this.resolveFocusStory(sessionId);
    if (!focusStory) return undefined;

    let mgr: StoryIndexManager;
    try {
      mgr = this.getStoryManager(sessionId);
    } catch {
      return undefined;
    }

    const parts: string[] = [];
    parts.push(`## Current Focus: [[${focusStory.id}]] ${focusStory.title}`);
    parts.push("");
    parts.push("### Attributes");
    parts.push(`- Subject: [[subject:${focusStory.attributes.subject}]]`);
    parts.push(`- Type: [[type:${focusStory.attributes.type}]]`);
    parts.push(`- Scenario: [[scenario:${focusStory.attributes.scenario}]]`);
    parts.push("");
    parts.push(`### Status: ${focusStory.status}`);
    parts.push("");
    parts.push("### Narrative (full)");
    parts.push(focusStory.narrative.slice(-2000));

    const summaryDetails = await this.extractSummaryDetails(sessionId, focusStory);
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

    if (focusStory.sources.length > 0) {
      parts.push("", "### Sources");
      for (const src of focusStory.sources) {
        parts.push(`- ${src.summaryPath} (msg ${src.messageRange[0]}-${src.messageRange[1]})`);
      }
    }

    const entityParts = await this.buildEntityDescriptions(mgr, focusStory);
    if (entityParts) {
      parts.push("", "## Entity Context");
      parts.push(entityParts);
    }

    return parts.join("\n");
  }

  private async extractSummaryDetails(
    sessionId: string,
    story: StoryDocument,
  ): Promise<{ task: string; files: string[]; operations: Array<{ op: string; target: string; result: string }> }> {
    const result = { task: "", files: [] as string[], operations: [] as Array<{ op: string; target: string; result: string }> };

    for (const src of story.sources.slice(-3)) {
      const partials = await this.storyStorage.readSummaryPartials(sessionId, src.summaryPath);
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
    mgr: StoryIndexManager,
    story: StoryDocument,
  ): Promise<string | undefined> {
    const dims: Array<["subject" | "type" | "scenario", string]> = [
      ["subject", story.attributes.subject],
      ["type", story.attributes.type],
      ["scenario", story.attributes.scenario],
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

  /** Build Layer 2: recent story summaries. */
  private async buildRecentStories(sessionId: string): Promise<string | undefined> {
    let mgr: StoryIndexManager;
    try {
      mgr = this.getStoryManager(sessionId);
    } catch {
      return undefined;
    }

    const allStories = mgr.getAllStories();
    if (allStories.length === 0) return undefined;

    const focusStory = this.resolveFocusStory(sessionId);
    const recentCount = this.config.recentStoryCount;

    const recent = allStories
      .filter((e) => !focusStory || e.id !== focusStory.id)
      .sort((a, b) => b.lastUpdated - a.lastUpdated)
      .slice(0, recentCount);

    if (recent.length === 0) return undefined;

    const parts: string[] = ["## Recent Stories"];
    for (const s of recent) {
      const narrativeTail = s.narrative.slice(-500);
      const sourcesStr = s.sources
        .slice(-2)
        .map((src) => src.summaryPath)
        .join(", ");
      parts.push("");
      parts.push(`- [[${s.id}]] ${s.title} (${s.status})`);
      parts.push(`  ${this.clip(narrativeTail.replace(/\n/g, " "), 200)}`);
      if (sourcesStr) {
        parts.push(`  Sources: ${sourcesStr}`);
      }
    }

    return parts.join("\n");
  }

  /** Build Layer 3: recent summary contents for continuity. */
  private async buildRecentSummaries(sessionId: string, s: SessionState): Promise<string | undefined> {
    const count = this.config.recentSummaryCount;
    if (count <= 0 || s.compressedWindows.length === 0) return undefined;

    const recentWindows = s.compressedWindows.slice(-count);
    const parts: string[] = ["## Recent Summaries"];

    for (const win of recentWindows) {
      const content = await this.storyStorage.readSummaryContent(sessionId, win.storagePath);
      if (!content) continue;
      parts.push("");
      parts.push(`### ${win.storagePath} (msg ${win.messageRange[0]}-${win.messageRange[1]})`);
      parts.push(content);
    }

    return parts.length > 1 ? parts.join("\n") : undefined;
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
    const storyMgr = this.getStoryManager(params.sessionId);

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
      let storySummaries: StorySummary[];
      const knownDimensions = storyMgr.getKnownDimensions();
      const dims = knownDimensions.subjects.length > 0 ? knownDimensions : undefined;

      if (this.summarizer) {
        const coreText = nonDroppedCore
          .map((m) => `[${extractRole(m)}]: ${extractText(m)}`)
          .join("\n\n");
        try {
          const { rawOutput, stories: llmStories } = await extractStoriesWithLLM(
            nonDroppedCore,
            window.preOverlap,
            window.postOverlap,
            this.summarizer,
            "",
            [window.coreStartIdx, window.coreEndIdx],
            dims,
          );
          markdown = rawOutput;
          storySummaries = llmStories;
        } catch {
          markdown = this.compactor.buildStructuralSummary(nonDroppedCore);
          storySummaries = extractStoriesStructural(
            nonDroppedCore, "", [window.coreStartIdx, window.coreEndIdx], dims,
          );
        }
      } else {
        markdown = this.compactor.buildStructuralSummary(nonDroppedCore);
        storySummaries = extractStoriesStructural(
          nonDroppedCore, "", [window.coreStartIdx, window.coreEndIdx], dims,
        );
      }

      if (storySummaries.length === 0 && markdown.trim().length === 0) {
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

      storySummaries = storySummaries.map((e) => ({ ...e, sourceSummary: compressed.storagePath }));

      // Record window range in DB (messages already stored by ingest, no duplication)
      this.messageStore.addWindow(params.sessionId, compressed);

      s.compressedWindows.push(compressed);
      s.activeEnd = window.coreEndIdx;

      if (storySummaries.length > 0) {
        await storyMgr.processSummaries(storySummaries);
        s.activeStories = storyMgr.getActiveStories().map((e) => e.id);
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
        reason: `restored from disk (${loaded.compressedWindows.length} compressed windows, ${loaded.activeStories.length} active stories)`,
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

    for (const mgr of this.storyManagers.values()) {
      mgr.close();
    }
    this.storyManagers.clear();

    // Close all DBs after story managers are done
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
