# Story Context

An agent-centric context engine plugin for [OpenClaw](https://github.com/nicepkg/openclaw). Provides sliding-window context compression with active story management via inner turn B→A architecture.

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

// Compress when budget exceeded (pure compression, no story extraction)
await engine.compact({ sessionId: "main", sessionFile: "" });

// Build context for LLM
const result = await engine.assemble({ sessionId: "main", messages: [] });
```

To use a custom OpenAI-compatible API (e.g., local Ollama), set `summaryMode: "http"` and configure `summaryBaseUrl`.

## How It Works

The engine manages context through four phases:

1. **Ingest** — Receive messages with content filtering and dedup
2. **AfterTurn** — Process messages, increment turn counter, trigger inner turn every N turns
3. **Inner Turn** — Story management: B creates/updates stories, A recovers on B failure
4. **Compact** — Pure compression: structural summary when over budget (no LLM)

Stories are managed by inner turn and categorized by three orthogonal dimensions:

| Dimension | Agent Perspective | Examples |
|-----------|-------------------|----------|
| **type** | What action the agent takes | implementation, debugging, exploration, analysis, configuration |
| **subject** | What entity the agent works on | auth-module, crawler-pipeline, deployment |
| **scenario** | What domain the work belongs to | software.coding, data.crawling, system.ops, general |

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
