import { resolveConfig, CHARS_PER_TOKEN } from "./config.js";
import type { SessionState, SmartContextConfig, Summarizer } from "./types.js";
import { ContentProcessor } from "./content-processor.js";
import { ContentStorage } from "./content-storage.js";
import { StoryIndexManager } from "./story-index.js";
import { StoryStorage } from "./story-storage.js";
import { MessageStore } from "./message-store.js";
import { runInnerTurn, sampleMessagesText } from "./inner-turn.js";
import type { StoryDocument } from "./story-types.js";

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
    tokensBefore: number;
    tokensAfter?: number;
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
    id: "story-context",
    name: "Smart Context Engine",
    version: "3.0.0",
    ownsCompaction: true,
    turnMaintenanceMode: "foreground",
  };

  private readonly config: SmartContextConfig;
  private readonly sessions = new Map<string, SessionState>();
  private readonly summarizer?: Summarizer;
  private readonly contentProcessor: ContentProcessor;
  private readonly storage: ContentStorage;
  private readonly storyManagers = new Map<string, StoryIndexManager>();
  private readonly storyStorage: StoryStorage;
  private readonly messageStore: MessageStore;
  private lastInnerTurnResult?: { success: boolean; createdCount: number; updatedCount: number; error?: string };

  constructor(config: Record<string, unknown> = {}, summarizer?: Summarizer) {
    this.config = resolveConfig(config);
    this.summarizer = summarizer;
    this.storage = new ContentStorage(this.config.storageDir || undefined);
    this.storyStorage = new StoryStorage(this.storage);
    this.contentProcessor = new ContentProcessor(
      {
        largeTextThreshold: this.config.largeTextThreshold,
        contentFilters: this.config.contentFilters,
        llmEnabled: this.config.llmEnabled,
      },
      this.storage,
      summarizer,
    );
    this.messageStore = new MessageStore(this.config.storageDir || "");
  }

  // ── Session helpers ─────────────────────────────────────────────

  private state(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        messages: [],
        seenReads: new Map(),
        activeStories: [],
        lastProcessedIdx: 0,
        currentTurn: 0,
        turnsSinceInnerTurn: 0,
        innerTurnRunning: false,
        cleanedSamples: [],
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

  private getEffectiveMessageWindow(s: SessionState): number {
    return s.adjustedMessageWindowSize ?? this.config.messageWindowSize;
  }

  private getEffectiveMaxActiveStories(s: SessionState): number {
    return s.adjustedMaxActiveStories ?? this.config.maxActiveStories;
  }

  private getStoryManager(sessionId: string): StoryIndexManager {
    let mgr = this.storyManagers.get(sessionId);
    if (!mgr) {
      const db = this.messageStore.getDb(sessionId);
      mgr = new StoryIndexManager(db, this.storyStorage, sessionId);
      this.storyManagers.set(sessionId, mgr);
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
    const role = extractRole(params.message);
    let content = (params.message as { content?: unknown }).content;

    // Only persist large tool outputs to prevent context overflow.
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

      // Capture filter effect for InnerTurnA
      const filterSample = this.contentProcessor.applyFiltersOnly(msg.content);
      if (filterSample.changed) {
        if (s.cleanedSamples.length >= 10) s.cleanedSamples.shift();
        s.cleanedSamples.push({ raw: filterSample.raw, cleaned: filterSample.cleaned });
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
    for (let i = 0; i < turnStart; i++) {
      const msg = s.messages[i] as Record<string, unknown>;
      if (extractRole(msg) === "toolResult" && !isDropped(msg)) {
        const text = typeof msg.content === "string" ? msg.content : "";
        if (text.length > this.config.largeTextThreshold) {
          msg.content = "[Old tool result content cleared]";
        }
      }
    }

    s.lastProcessedIdx = s.messages.length;

    // Persist: write finalized messages to DB
    for (let i = turnStart; i < s.messages.length; i++) {
      this.messageStore.upsertMessage(params.sessionId, i, s.messages[i]);
    }
    for (let i = 0; i < turnStart; i++) {
      const msg = s.messages[i] as Record<string, unknown>;
      const text = typeof msg.content === "string" ? msg.content : "";
      if (extractRole(msg) === "toolResult" && !isDropped(msg) && text === "[Old tool result content cleared]") {
        this.messageStore.upsertMessage(params.sessionId, i, msg);
      }
    }

    // 3. Increment turn counter
    s.currentTurn++;
    s.turnsSinceInnerTurn++;

    // 4. Expire old stories
    const storyMgr = this.getStoryManager(params.sessionId);
    storyMgr.expireOldStories(s.currentTurn);

    // 5. Trigger inner turn if threshold reached
    if (
      s.turnsSinceInnerTurn >= this.config.innerTurnInterval &&
      !s.innerTurnRunning &&
      this.summarizer
    ) {
      s.innerTurnRunning = true;
      s.turnsSinceInnerTurn = 0;

      this.runInnerTurnAsync(params.sessionId).catch(() => {}).finally(() => {
        const st = this.sessions.get(params.sessionId);
        if (st) st.innerTurnRunning = false;
      });
    }

    this.messageStore.saveState(params.sessionId, s);
    this._persistContentFilters(params.sessionId);
  }

  // ── Story Focus ─────────────────────────────────────────────────

  private async runInnerTurnAsync(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const storyMgr = this.getStoryManager(sessionId);

    const result = await runInnerTurn({
      summarizer: this.summarizer!,
      storyManager: storyMgr,
      currentTurn: s.currentTurn,
      activeStoryTTL: this.config.activeStoryTTL,
      maxActiveStories: this.getEffectiveMaxActiveStories(s),
      sampleMessages: () => sampleMessagesText(s.messages, this.getEffectiveMessageWindow(s)),
      sampleRawCleaned: () => s.cleanedSamples,
      currentFilters: () => this.config.contentFilters,
      applyFilterRules: (rules) => {
        this.config.contentFilters = rules;
        this._persistContentFilters(sessionId);
      },
    });

    this.lastInnerTurnResult = result;
    s.activeStories = storyMgr.getActiveStoriesByTurn(s.currentTurn).map(e => e.id);
    this.messageStore.saveState(sessionId, s);
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
    const windowSize = this.getEffectiveMessageWindow(s);
    const all = [...s.messages, ...params.messages].filter((m) => !isDropped(m));
    const recent = all.slice(-windowSize);

    const selected: unknown[] = [];
    let totalChars = 0;
    const seenInWindow = new Map<string, number>();

    for (let i = 0; i < recent.length; i++) {
      const msg = recent[i];

      if (this.config.dedupReads) {
        const toolName = extractToolName(msg);
        if (toolName === "read_file") {
          const filePath = extractToolArg(msg, "path");
          if (filePath) {
            if (seenInWindow.has(filePath)) continue;
            seenInWindow.set(filePath, i);
          }
        }
      }

      selected.push(msg);
      totalChars += extractText(msg).length;
    }

    const systemParts: string[] = [];
    const storyContext = this.buildStoryContext(params.sessionId, s);
    if (storyContext) systemParts.push(storyContext);

    const estimatedTokens = Math.ceil(
      (totalChars + systemParts.join("\n").length) / CHARS_PER_TOKEN,
    );

    return {
      messages: selected,
      estimatedTokens,
      systemPromptAddition: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    };
  }

  /** Build story context: full narrative for top stories, truncated for rest. */
  private buildStoryContext(sessionId: string, s: SessionState): string | undefined {
    let mgr: StoryIndexManager;
    try {
      mgr = this.getStoryManager(sessionId);
    } catch {
      return undefined;
    }

    const maxActive = this.getEffectiveMaxActiveStories(s);
    const active = mgr.getActiveStoriesByTurn(s.currentTurn).slice(0, maxActive);
    if (active.length === 0) return undefined;

    const parts: string[] = ["## Active Stories"];
    const fullCount = Math.min(this.config.fullStoryCount, maxActive);

    for (let i = 0; i < active.length; i++) {
      const story = active[i];
      if (i < fullCount) {
        parts.push("");
        parts.push(`### [[${story.id}]] ${story.title}`);
        parts.push(`- Subject: [[subject:${story.attributes.subject}]]`);
        parts.push(`- Type: [[type:${story.attributes.type}]]`);
        parts.push(`- Scenario: [[scenario:${story.attributes.scenario}]]`);
        parts.push("");
        parts.push(story.narrative.slice(-2000));
      } else {
        const tail = story.narrative.slice(-500);
        parts.push("");
        parts.push(`- [[${story.id}]] ${story.title}`);
        parts.push(`  ${this.clip(tail.replace(/\n/g, " "), 200)}`);
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

    // Estimate current context size
    const windowSize = this.getEffectiveMessageWindow(s);
    const maxActive = this.getEffectiveMaxActiveStories(s);
    const active = s.messages.filter((m) => !isDropped(m));
    const recent = active.slice(-windowSize);
    let totalChars: number = recent.reduce((sum: number, msg) => sum + extractText(msg).length, 0);

    // Add estimated story context size
    let storyChars = 0;
    try {
      const mgr = this.getStoryManager(params.sessionId);
      const stories = mgr.getActiveStoriesByTurn(s.currentTurn).slice(0, maxActive);
      storyChars = stories.reduce((sum: number, st) => sum + st.narrative.length, 0);
    } catch { /* no stories */ }
    totalChars += storyChars;

    const tokensBefore = Math.ceil(totalChars / CHARS_PER_TOKEN);

    if (totalChars <= budgetChars && !params.force) {
      // Within budget — reset adjustments
      s.adjustedMessageWindowSize = undefined;
      s.adjustedMaxActiveStories = undefined;
      this.messageStore.saveState(params.sessionId, s);
      return { ok: true, compacted: false, reason: "within budget" };
    }

    // Over budget — proportionally reduce
    const ratio = budgetChars / totalChars;
    s.adjustedMessageWindowSize = Math.max(2, Math.floor(this.config.messageWindowSize * ratio));
    s.adjustedMaxActiveStories = Math.max(1, Math.floor(this.config.maxActiveStories * ratio));

    const tokensAfter = Math.ceil(totalChars * ratio);

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

      // Rebuild story index from SQLite
      const storyMgr = this.getStoryManager(params.sessionId);
      storyMgr.loadFromDb();

      return {
        bootstrapped: true,
        importedMessages: loaded.messages.length,
        reason: `restored from disk (${loaded.activeStories.length} active stories)`,
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

  /** @internal Exposed for web UI. */
  _getStoryManager(sessionId: string): StoryIndexManager | undefined {
    if (!this.sessions.has(sessionId)) return undefined;
    return this.getStoryManager(sessionId);
  }

  /** @internal Last inner turn result for logging. */
  _getLastInnerTurnResult() {
    const r = this.lastInnerTurnResult;
    this.lastInnerTurnResult = undefined;
    return r;
  }

  /** @internal Persist contentFilters to DB so inspector can read them. */
  _persistContentFilters(sessionId: string): void {
    const db = this.messageStore.getDb(sessionId);
    db.prepare("INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)")
      .run("contentFilters", JSON.stringify(this.config.contentFilters));
  }
}

// ── Message extraction helpers ─────────────────────────────────────

function extractRole(msg: unknown): string {
  return (msg as { role?: string }).role ?? "unknown";
}

export function extractText(msg: unknown): string {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as { type?: string; text?: string; content?: string };
          if (typeof p.text === "string") return p.text;
          if (p.type === "text" && typeof p.content === "string") return p.content;
        }
        return "";
      })
      .join(" ")
      .trim();
  }
  return "";
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
