# Story Context

An agent-centric context engine plugin for [OpenClaw](https://github.com/nicepkg/openclaw). Provides sliding-window context compression with story extraction, indexing, and retrieval.

## Install

```bash
npm install story-context
```

## Quick Start

```typescript
import { SmartContextEngine, HttpSummarizer } from "story-context";

const summarizer = new HttpSummarizer({
  baseUrl: "http://localhost:11434/v1",
  model: "qwen2.5:3b",
});

const engine = new SmartContextEngine({
  maxHistoryTokens: 16000,
  summaryEnabled: true,
  storageDir: "./data",
}, summarizer);

// Feed messages
await engine.ingest({ sessionId: "main", message: msg });
await engine.afterTurn({ sessionId: "main", sessionFile: "" });

// Compress when budget exceeded
await engine.compact({ sessionId: "main", sessionFile: "" });

// Build context for LLM
const result = await engine.assemble({ sessionId: "main", messages: [] });
```

## How It Works

The engine manages context through three phases:

1. **Ingest** — Receive messages with content filtering and dedup
2. **Compact** — Compress old messages into summaries, extract stories
3. **Assemble** — Build a 3-layer context: focus story → recent stories → raw messages

Stories are categorized by three orthogonal dimensions:

| Dimension | Agent Perspective | Examples |
|-----------|-------------------|----------|
| **type** | What action the agent takes | development, debugging, exploration, analysis, configuration |
| **subject** | What entity the agent works on | auth-module, crawler-pipeline, deployment |
| **scenario** | What domain the work belongs to | software-engineering, data-engineering, system-ops, security |

## Documentation

- [Architecture & Configuration](docs/architecture.md)
- [Story Extraction Pipeline](docs/story-extraction.md)

## Test

```bash
npm test
```

## Build

```bash
npm run build
```

## License

MIT
