# Architecture

## Pipeline Overview

```
OpenClaw turn
  │
  ├─ ingest()          Persist large tool outputs
  │
  ├─ afterTurn()
  │   ├─ 1. Strip metadata, apply content filters
  │   ├─ 2. MicroCompact: clear old tool results
  │   ├─ 3. Persist to SQLite
  │   ├─ 4. currentTurn++, expire old stories
  │   └─ 5. Every N turns → async innerTurn
  │
  ├─ innerTurn (async, B→A architecture)
  │   │
  │   └─ InnerTurnB (story management)
  │       ├─ Input: existing stories + known dimensions + recent messages
  │       ├─ Output: batch actions (create/update/skip)
  │       ├─ All-or-nothing: any failure rolls back all operations
  │       ├─ Update actions → Round 2 confirmation with full story
  │       └─ Failure → InnerTurnA (content quality recovery)
  │           ├─ Input: failure context + raw/cleaned data comparison
  │           ├─ Output: new filter rules
  │           └─ Failure → retry with error hint (max 3 attempts)
  │
  ├─ compact()         Pure compression (structural summary, no LLM)
  │
  └─ assemble()        Active stories + recent X messages
```

## Inner Turn State Machine

```
B_start ──→ B outputs create/update/skip
  │              │
  │         create + skip
  │              → execute all (all-or-nothing) → done
  │
  │         update
  │              → Round 2: confirm with full story
  │              → execute → done
  │
  │         B fails (JSON parse / execution error)
  │              → A generates filter rules
  │              → A succeeds → apply rules → B_start (retry)
  │              → A fails → retry A (max 3) → give up
```

## Core Flow

### ingest()

Receive messages through ContentProcessor which:
- Filters content matching configured rules (message/block/line granularity)
- Outlines large text outputs exceeding threshold
- Stores media files to disk

### afterTurn()

Post-turn processing:
1. Strip platform metadata from user messages
2. Apply content filters (drop/strip messages)
3. MicroCompact: clear old tool results from previous turns
4. Persist to SQLite
5. Increment `currentTurn`, expire stories past TTL
6. If `turnsSinceInnerTurn >= innerTurnInterval` and summarizer available, fire inner turn async

### innerTurn

Story management via LLM, triggered every `innerTurnInterval` turns:

**InnerTurnB** — Analyzes recent messages and outputs batch actions:
- `create`: New story with subject/type/scenario/content
- `update`: Update existing story narrative (append or replace)
- `skip`: No changes

All actions execute all-or-nothing. Any failure triggers rollback.

**InnerTurnA** — Recovery when B fails:
- Analyzes raw vs cleaned data to generate filter rules
- Rules are applied and B is retried

### compact()

When active messages exceed `maxHistoryTokens`:
1. Build overlapping compression windows from oldest messages
2. Generate structural summary (no LLM call)
3. Save markdown summary to disk
4. Advance `activeEnd` pointer

### assemble()

Build context for the LLM:
1. **Active Stories** — Stories with `activeUntilTurn >= currentTurn`, sorted by `lastEditedTurn` descending
2. **Raw Messages** — Active (uncompressed) messages with dedup

## Active Story Lifecycle

Stories have a TTL-based lifecycle:

- **Create**: `activeUntilTurn = currentTurn + activeStoryTTL`
- **Update**: `activeUntilTurn` reset to `currentTurn + activeStoryTTL`
- **Expire**: When `activeUntilTurn < currentTurn`, story becomes inactive
- **Evict**: When active count exceeds `maxActiveStories`, oldest by `lastEditedTurn` are evicted (FIFO)

## Disk Storage

```
{storageDir}/{sessionId}/
├── summaries/       # Compressed summaries (YYYY-MM-DD-N.md)
├── stories/         # Story documents (story-{hash}.md)
├── subjects/        # Subject entity documents
├── types/           # Type entity documents
├── scenarios/       # Scenario entity documents
├── text/            # Large text storage
├── media/           # Media file storage
└── session.db       # SQLite index (FTS5)
```

## Configuration

All budget units are **tokens** (internally ×4 for char conversion).

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxHistoryTokens` | int | 16000 | Token budget before compaction triggers |
| `compactCoreTokens` | int | 6000 | Token size per compression window |
| `compactOverlapTokens` | int | 1000 | Overlap between compression windows |
| `recentStoryCount` | int | 10 | Number of recent stories in assemble |
| `recentSummaryCount` | int | 3 | Number of recent summaries for continuity |
| `recentMessageCount` | int | 30 | Recent messages included in assemble |
| `innerTurnInterval` | int | 20 | Trigger inner turn every N turns |
| `innerTurnMessageSample` | int | 30 | Messages sampled for inner turn input |
| `maxActiveStories` | int | 10 | Max active stories before eviction |
| `activeStoryTTL` | int | 40 | Turns before a story expires |
| `dedupReads` | bool | true | Deduplicate repeated read_file results |
| `recentWindowSize` | int | 6 | Recent messages exempt from dedup |
| `sessionFilter` | string/array | "main" | Session filter: main/all/regex array |
| `storageDir` | string | system temp | Storage root directory |
| `largeTextThreshold` | int | 2000 | Char threshold for text outlining |
| `summaryEnabled` | bool | false | Enable LLM summarization |
| `summaryMode` | string | "runtime" | runtime = OpenClaw model, http = OpenAI-compatible API |
| `summaryBaseUrl` | string | http://localhost:11434/v1 | API URL for http mode |
| `summaryModel` | string | "" | Model name (empty = default) |
| `summaryTargetTokens` | int | 600 | Target token count for summaries |
| `summaryTimeoutMs` | int | 30000 | HTTP timeout for http mode |
| `contentFilters` | array | [] | Content filter rules |

## Source Files

| File | Responsibility |
|------|---------------|
| `src/engine.ts` | Main engine: ingest, afterTurn, assemble, compact, inner turn trigger |
| `src/inner-turn.ts` | Inner turn B→A loop: story management + failure recovery |
| `src/story-index.ts` | SQLite story index, CRUD + dimension matching + active lifecycle |
| `src/story-extractor.ts` | LLM/structural story extraction + dimension normalization |
| `src/story-storage.ts` | YAML document read/write (Obsidian-compatible) |
| `src/compactor.ts` | Compression window building + structural summaries |
| `src/content-processor.ts` | Content filtering, outlining, media handling |
| `src/summarizer.ts` | Runtime and HTTP LLM invocation modes |
| `src/message-store.ts` | SQLite message persistence + session state |
| `src/content-storage.ts` | Disk storage management |
