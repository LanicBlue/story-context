# Story Extraction & Management

## Overview

Story management is handled by the **inner turn** mechanism, triggered every `innerTurnInterval` turns via `afterTurn()`. Inner turn B analyzes recent messages and outputs story operations (create/update/skip). Inner turn A acts as a failure recovery mechanism, generating filter rules when B fails.

## Three-Dimension Schema

Stories are categorized by three orthogonal dimensions from the agent's perspective:

| Dimension | Question | Predefined Set |
|-----------|----------|----------------|
| **type** | What action does the agent take? | implementation, debugging, testing, exploration, analysis, design, optimization, configuration, assistance, decision, execution |
| **subject** | What entity does the agent work on? | Free-form (project name, system name, topic) |
| **scenario** | What domain does the work belong to? | software.coding, software.testing, software.devops, software.architecture, data.crawling, data.engineering, data.analytics, system.ops, system.automation, content.writing, content.design, content.media, media.public-opinion, research.knowledge, general |

### Design Rationale

The three dimensions are intentionally orthogonal:

- **type** is the agent's action verb (implementation vs debugging)
- **subject** is the target entity (crawler vs auth-module)
- **scenario** is the professional domain (software.coding vs data.crawling)

Same project + same action + different domain = different story. This avoids overlapping dimensions.

## Inner Turn B — Story Management

### Input

InnerTurnB receives:
- All existing stories (ID, attributes, narrative preview)
- Known dimension values (for reuse encouragement)
- Recent cleaned messages (last `innerTurnMessageSample` messages)

### Output Format

```json
{
  "actions": [
    { "action": "create", "story": { "subject": "...", "type": "...", "scenario": "...", "content": "..." } },
    { "action": "update", "targetStoryId": "...", "updatedContent": "...", "append": true }
  ]
}
```

No changes: `{"actions":[]}`

### Batch Execution

All actions execute all-or-nothing:
- Any failure → rollback all created stories → trigger InnerTurnA
- Create sets `activeUntilTurn = currentTurn + activeStoryTTL`
- Update resets TTL and requires Round 2 confirmation with the full story

### Round 2 (Update Confirmation)

When B outputs update actions:
1. Fetch full story documents for all update targets
2. Send to B for confirmation with full narrative context
3. Execute confirmed updates

## Inner Turn A — Failure Recovery

Triggered when B fails (JSON parse error, execution failure):

1. Receives B's failure context + raw vs cleaned message samples
2. Outputs new filter rules: `{"rules":[{"match":"contains|regex","pattern":"...","granularity":"message|block|line"}],"reason":"..."}`
3. Rules are applied, B is retried
4. A retries up to 3 times with injected failure hints

## Matching and Merging

Stories are matched using **normalized three-dimension comparison**:

```typescript
normalizeDim(subject) === normalizeDim(other.subject) &&
normalizeDim(type)    === normalizeDim(other.type) &&
normalizeDim(scenario) === normalizeDim(other.scenario)
```

Normalization takes the first value from comma-separated lists and trims whitespace. This handles common LLM output issues:
- `"implementation,debugging"` → `"implementation"` (take first)
- `"software.coding，data.crawling"` → `"software.coding"` (Chinese comma)

Story IDs are generated from the normalized dimension values (SHA-256 hash), ensuring consistent IDs across similar dimension values.

## Dimension Normalization

The `normalizeDimensionValue()` function splits on commas (`,`, `，`, `、`) and takes the first value:

```typescript
"implementation,debugging" → "implementation"
"software.coding，data.crawling" → "software.coding"
"  debugging  " → "debugging"
```
