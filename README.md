# story-context

A story-driven context engine with budget-aware message assembly for [OpenClaw](https://github.com/nicepkg/openclaw). Manages conversation context through active stories that track topics across turns, using a compact/regulate cycle instead of traditional compression.

## Core Concepts

**Stories** are the unit of working memory. Each story tracks a conversation topic along three dimensions:

| Dimension | Purpose | Examples |
|-----------|---------|----------|
| **subject** | Concrete entity name (reuse existing) | auth-module, crawler-pipeline, server-03 |
| **type** | What kind of entity (preset + existing) | person, project, tool, device, environment, concept |
| **scenario** | Action name (preset + existing) | bug-fix, deployment, architecture-design, debugging |

**Inner turn** uses an LLM (B->A architecture) to create, update, or skip stories based on recent conversation history. InnerTurnB outputs batch actions; on failure, InnerTurnA generates filter rules and retries.

**compact** is a budget regulator, not a compressor. When the estimated context size exceeds `maxHistoryTokens`, it proportionally reduces `messageWindowSize` and `maxActiveStories` for the next `assemble` call. No LLM invocation, no file generation.

**assemble** builds the final context for the LLM. It takes the last N messages (where N = `messageWindowSize`, possibly reduced by compact) and active stories sorted by recency. Story display uses a two-layer model:

- Top `fullStoryCount` stories -- full narrative
- Next up to `summaryStoryCount` stories -- truncated narrative (last 200 chars)

## Quick Start

```bash
npm install
npm run build
```

Configure in `openclaw.plugin.json`:

```json
{
  "id": "story-context",
  "kind": "context-engine",
  "config": {
    "enabled": true,
    "maxHistoryTokens": 120000,
    "llmEnabled": true,
    "storageDir": "./data"
  }
}
```

Programmatic usage:

```typescript
import { SmartContextEngine } from "story-context";

const engine = new SmartContextEngine({
  maxHistoryTokens: 120000,
  storageDir: "./data",
  llmEnabled: true,
});

await engine.ingest({ sessionId: "main", message: msg });
await engine.afterTurn({ sessionId: "main", sessionFile: "" });
await engine.compact({ sessionId: "main", sessionFile: "" });
const result = await engine.assemble({ sessionId: "main", messages: [] });
```

## Architecture

```
OpenClaw turn
  |
  +-- ingest()          Persist large tool outputs to disk
  |
  +-- afterTurn()
  |   |-- 1. Strip metadata, apply content filters
  |   |-- 2. MicroCompact: clear old tool results
  |   |-- 3. Persist to SQLite
  |   |-- 4. currentTurn++, expire old stories
  |   +-- 5. Every N turns --> async innerTurn
  |
  +-- innerTurn (async, B->A architecture)
  |   +-- InnerTurnB (story management)
  |       |-- Input: existing stories + known dimensions + recent messages
  |       |-- Output: batch actions (create/update/skip)
  |       |-- All-or-nothing: any failure rolls back all operations
  |       |-- Update actions --> Round 2 confirmation with full story
  |       +-- Failure --> InnerTurnA (content quality recovery)
  |           |-- Input: failure context + raw/cleaned data comparison
  |           |-- Output: new filter rules
  |           +-- Failure --> retry with error hint (max 3 attempts)
  |
  +-- compact()         Budget regulator (no LLM, no file generation)
  |
  +-- assemble()        Recent N messages + two-layer story context
```

## Configuration

All budget units are tokens (internally multiplied by 4 for character conversion).

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxHistoryTokens` | int | 120000 | Token budget -- compact adjusts load params when exceeded |
| `messageWindowSize` | int | 30 | Number of recent messages to load in assemble and inner turn input |
| `innerTurnInterval` | int | 20 | Trigger inner turn every N turns |
| `maxActiveStories` | int | 13 | Max active stories before FIFO eviction |
| `fullStoryCount` | int | 3 | Top N active stories shown with full narrative |
| `summaryStoryCount` | int | 10 | Additional stories shown with truncated narrative |
| `activeStoryTTL` | int | 40 | Turns before a story expires |
| `dedupReads` | bool | true | Deduplicate repeated read_file results |
| `sessionFilter` | string/array | "main" | Session filter: main / all / regex array |
| `storageDir` | string | system temp | Storage root directory |
| `largeTextThreshold` | int | 2000 | Character threshold for large text persistence |
| `llmEnabled` | bool | false | Enable LLM service for inner turn and content processing |
| `llmMode` | string | "runtime" | runtime = OpenClaw model, http = OpenAI-compatible API |
| `llmBaseUrl` | string | http://localhost:11434/v1 | API URL for http mode |
| `llmModel` | string | "" | Model name (empty = default) |
| `llmTimeoutMs` | int | 30000 | HTTP timeout for http mode |
| `contentFilters` | array | [] | Content filter rules |

## Storage Structure

```
{storageDir}/{sessionId}/
  session.db       # SQLite index (FTS5)
  stories/         # Story documents (story-{hash}.md)
  subjects/        # Subject entity documents
  types/           # Type entity documents
  scenarios/       # Scenario entity documents
  text/            # Large text storage
  media/           # Media file storage
```

## Development

```bash
npm test
npm run build
```

## License

MIT
