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
  ├─ compact()         Budget regulator — adjusts load params when over budget
  │
  └─ assemble()        Recent N messages (N may be reduced) + stories
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
- Persists large text outputs exceeding threshold to disk
- Stores media files to disk

### afterTurn()

Post-turn processing:
1. Strip platform metadata from user messages
2. Apply content filters (drop/strip messages)
3. MicroCompact: clear old tool results from previous turns
4. Persist to SQLite
5. Increment `currentTurn`, expire stories past TTL
6. If `turnsSinceInnerTurn >= innerTurnInterval` and LLM available, fire inner turn async

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

Budget regulator — no file generation, no LLM call:
1. Estimate current context size (messages + story context)
2. If within `maxHistoryTokens` → `compacted: false`, reset params to defaults
3. If over budget → proportionally reduce `messageWindowSize` and `maxActiveStories`
4. Adjusted values stored in session state for next `assemble()` call

### assemble()

Build context for the LLM:
1. **Messages** — Take last N messages (N = `messageWindowSize`), with read_file dedup
2. **Stories** — Active stories sorted by `lastUpdated`:
   - Top `fullStoryCount` stories → full narrative
   - Next up to `summaryStoryCount` stories → truncated narrative (last 200 chars)

## Active Story Lifecycle

Stories have a TTL-based lifecycle:

- **Create**: `activeUntilTurn = currentTurn + activeStoryTTL`
- **Update**: `activeUntilTurn` reset to `currentTurn + activeStoryTTL`
- **Expire**: When `activeUntilTurn < currentTurn`, story becomes inactive
- **Evict**: When active count exceeds `maxActiveStories`, oldest by `lastEditedTurn` are evicted (FIFO)

## Disk Storage

```
{storageDir}/{sessionId}/
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
| `maxHistoryTokens` | int | 120000 | Token budget — compact adjusts load params when exceeded |
| `messageWindowSize` | int | 30 | Number of recent messages to load (assemble + innerTurn input) |
| `innerTurnInterval` | int | 20 | Trigger inner turn every N turns |
| `maxActiveStories` | int | 13 | Max active stories before eviction |
| `fullStoryCount` | int | 3 | Top N active stories shown with full narrative |
| `summaryStoryCount` | int | 10 | Additional stories shown with truncated narrative |
| `activeStoryTTL` | int | 40 | Turns before a story expires |
| `dedupReads` | bool | true | Deduplicate repeated read_file results |
| `sessionFilter` | string/array | "main" | Session filter: main/all/regex array |
| `storageDir` | string | system temp | Storage root directory |
| `largeTextThreshold` | int | 2000 | Char threshold for large text persistence |
| `llmEnabled` | bool | false | Enable LLM service for inner turn + content processing |
| `llmMode` | string | "runtime" | runtime = OpenClaw model, http = OpenAI-compatible API |
| `llmBaseUrl` | string | http://localhost:11434/v1 | API URL for http mode |
| `llmModel` | string | "" | Model name (empty = default) |
| `llmTimeoutMs` | int | 30000 | HTTP timeout for http mode |
| `contentFilters` | array | [] | Content filter rules |

## Source Files

| File | Responsibility |
|------|---------------|
| `src/engine.ts` | Main engine: ingest, afterTurn, assemble, compact (budget regulator), inner turn trigger |
| `src/inner-turn.ts` | Inner turn B→A loop: story management + failure recovery |
| `src/story-index.ts` | SQLite story index, CRUD + dimension matching + active lifecycle |
| `src/story-storage.ts` | YAML document write (Obsidian-compatible) |
| `src/content-processor.ts` | Content filtering, large text persistence, media handling |
| `src/summarizer.ts` | Runtime and HTTP LLM invocation (rawGenerate) |
| `src/message-store.ts` | SQLite message persistence + session state |
| `src/content-storage.ts` | Disk storage management |
