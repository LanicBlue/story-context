# Story Extraction Pipeline

## Overview

During compaction, the engine extracts stories from each compression window. Stories capture what the agent did, what it worked on, and in what domain.

## Three-Dimension Schema

Stories are categorized by three orthogonal dimensions from the agent's perspective:

| Dimension | Question | Predefined Set |
|-----------|----------|----------------|
| **type** | What action does the agent take? | development, testing, execution, exploration, assistance, debugging, analysis, decision, configuration |
| **subject** | What entity does the agent work on? | Free-form (project name, system name, topic) |
| **scenario** | What domain does the work belong to? | software-engineering, data-engineering, system-ops, security, content-creation, knowledge-mgmt, user-interaction, general |

### Design Rationale

The three dimensions are intentionally orthogonal:

- **type** is the agent's action verb (development vs debugging)
- **subject** is the target entity (crawler vs auth-module)
- **scenario** is the professional domain (software-engineering vs data-engineering)

Same project + same action + different domain = different story. This avoids the common pitfall of overlapping dimensions (e.g., "troubleshooting" as both a type and a scenario).

## LLM Extraction Prompt

The prompt uses a schema-first structure with `[Schema]/[Rules]/[Output]` sections for better small-model compliance:

```
[Schema]
Extract stories as a JSON array. Each element:
{ "subject": "<target entity>", "type": "<agent action>", "scenario": "<work domain>", "content": "<narrative>" }

[Rules]
- subject: Short, stable, noun phrase.
- type: Pick ONE from {predefined set}.
- scenario: Pick ONE from {predefined set}.
- content: Concise 2-3 sentence narrative.
- Each field must be a SINGLE value. NO comma-separated lists.

[Output]
Output ONLY a JSON array.
```

Known dimension values from existing stories are injected as `[Known Schema]` to encourage reuse and consistency.

## Parsing Pipeline

```
LLM Output
    │
    ▼
parseStoryJsonOutput()  ←── Try JSON array [...]
    │                       Try single object {...}
    │                       Normalize comma-separated values
    │
    ├── Success → StorySummary[]
    │
    ▼ (fallback)
Legacy ---STORY--- blocks
    │
    ▼ (fallback)
Structural extraction (no LLM)
    │
    ▼
StorySummary[]
```

### Dimension Normalization

The `normalizeDimensionValue()` function handles common LLM output issues:
- `"development,debugging"` → `"development"` (take first)
- `"software-engineering，data-engineering"` → `"software-engineering"` (Chinese comma)
- Trims whitespace

## Matching and Merging

Stories are matched using **normalized three-dimension comparison**:

```typescript
normalizeDim(subject) === normalizeDim(other.subject) &&
normalizeDim(type)    === normalizeDim(other.type) &&
normalizeDim(scenario) === normalizeDim(other.scenario)
```

Normalization lowercases and strips comma-separated suffixes, so `"development,debugging"` matches `"development"`.

Story IDs are generated from the normalized dimension values (SHA-256 hash), ensuring consistent IDs even with minor dimension value differences.

## Summary Output Format

Extracted stories are formatted as markdown for the summary file:

```markdown
## 1. auth-module — development · software-engineering

Implemented JWT authentication with token refresh support.

---

## 2. auth-module — debugging · system-ops

Fixed token expiry causing 401 errors in production.
```
