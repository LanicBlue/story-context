# Story Context

An agent-centric context engine plugin for [OpenClaw](https://github.com/nicepkg/openclaw). Provides sliding-window context compression with story extraction, indexing, and retrieval.

## Install

Clone and build as an OpenClaw plugin:

```bash
git clone https://github.com/LanicBlue/story-context.git
cd story-context
npm install
npm run build
```

Then configure in your OpenClaw settings to use this context engine.

## Quick Start

The engine uses OpenClaw's built-in LLM by default (`summaryMode: "runtime"`). No external model setup needed.

```typescript
import { SmartContextEngine } from "story-context";

const engine = new SmartContextEngine({
  maxHistoryTokens: 16000,
  summaryEnabled: true,
  storageDir: "./data",
});

// Feed messages
await engine.ingest({ sessionId: "main", message: msg });
await engine.afterTurn({ sessionId: "main", sessionFile: "" });

// Compress when budget exceeded
await engine.compact({ sessionId: "main", sessionFile: "" });

// Build context for LLM
const result = await engine.assemble({ sessionId: "main", messages: [] });
```

To use a custom OpenAI-compatible API (e.g., local Ollama), set `summaryMode: "http"` and configure `summaryBaseUrl`.

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
