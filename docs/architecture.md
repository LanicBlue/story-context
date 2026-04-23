# Architecture

## Pipeline Overview

```
 ingest()          compact()            assemble()
 ─────────        ──────────          ──────────
 messages ──→ ContentProcessor ──→ Compactor ──→ 3-Layer Context
              (filter/outline)    (windowed       ├─ Layer 1: Focus Story
                                  compression)    │   + Entity Descriptions
                                                  ├─ Layer 2: Recent Stories
                                                  └─ Layer 3: Raw Messages
                       │
                       ▼
               StoryIndexManager (SQLite)
               ├─ Story Documents (stories/*.md)
               ├─ Entity Documents (subjects|types|scenarios/*.md)
               └─ Compressed Summaries (summaries/YYYY-MM-DD-N.md)
```

## Core Flow

### ingest()

Receive messages through ContentProcessor which:
- Filters content matching configured rules (message/block/line granularity)
- Outlines large text outputs exceeding threshold
- Stores media files to disk

### compact()

When active messages exceed `maxHistoryTokens`:
1. Build overlapping compression windows from oldest messages
2. For each window, call LLM to extract stories as JSON
3. Parse JSON into structured stories, normalize dimension values
4. Save formatted markdown summary to `summaries/YYYY-MM-DD-N.md`
5. Index stories into SQLite with FTS5 full-text search

### assemble()

Build a 3-layer context for the LLM:
1. **Focus Story** — Full narrative, entity descriptions, related summaries
2. **Recent Stories** — Last N story titles and snippets
3. **Raw Messages** — Active (uncompressed) messages with dedup

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
| `src/engine.ts` | Main engine: ingest, assemble, compact, story focus |
| `src/story-index.ts` | SQLite story index, CRUD + dimension matching |
| `src/story-extractor.ts` | LLM/structural story extraction + dimension normalization |
| `src/story-storage.ts` | YAML document read/write (Obsidian-compatible) |
| `src/compactor.ts` | Compression window building + LLM/structural summaries |
| `src/content-processor.ts` | Content filtering, outlining, media handling |
| `src/summarizer.ts` | Runtime and HTTP LLM invocation modes |
| `src/message-store.ts` | SQLite message persistence + session state |
| `src/content-storage.ts` | Disk storage management |
