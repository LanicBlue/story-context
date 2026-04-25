# Story Extraction & Management

## Overview

Story management is handled by the **inner turn** mechanism, triggered every `innerTurnInterval` turns via `afterTurn()`. Inner turn B analyzes recent messages and outputs story operations (create/update/skip). Inner turn A acts as a failure recovery mechanism, generating filter rules when B fails.

## Three-Dimension Schema

Stories are categorized by three orthogonal dimensions:

| Dimension | Question | Values |
|-----------|----------|--------|
| **subject** | What is the subject (name)? | Free-form, specific entity name. Reuse existing values when possible. |
| **type** | What kind of entity is the subject? | Presets: person, project, tool, device, document, dataset, event, workflow, organization, concept, environment, place. Reuse or create new. |
| **scenario** | What happened or what was done? | Action names (short words or hyphenated phrases). Presets: bug-fix, feature-development, deployment, code-review, architecture-design, debugging, investigation, discussion, refactoring, configuration, testing, optimization. Reuse or create new. |

### Design Rationale

The three dimensions are intentionally orthogonal:

- **subject** is the concrete entity name (auth-module vs crawler-pipeline)
- **type** is what kind of entity it is (project vs device)
- **scenario** is the action or event (bug-fix vs deployment)

Same subject + same type + different scenario = different story. This avoids overlapping dimensions.

For all three dimensions, available enum values = presets ∪ existing (deduplicated). Prefer reusing existing values; create new ones only when no existing value fits.

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
- `"project,tool"` → `"project"` (take first)
- `"bug-fix，deployment"` → `"bug-fix"` (Chinese comma)

Story IDs are generated from the normalized dimension values (SHA-256 hash), ensuring consistent IDs across similar dimension values.

## Dimension Normalization

The `normalizeDimensionValue()` function splits on commas (`,`, `，`, `、`) and takes the first value:

```typescript
"project,tool" → "project"
"bug-fix，deployment" → "bug-fix"
"  debugging  " → "debugging"
```
