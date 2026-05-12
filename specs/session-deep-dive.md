# Session Deep-Dive: Per-Turn & Per-Call Breakdown

## Overview

Add a "Deep Dive" view to the session detail panel that shows a hierarchical breakdown of LLM calls grouped by user turn. This lets users identify exactly which turns and calls drove costs, spot cache collapses, and understand per-request token economics.

## Motivation

When a session is expensive, the current detail view shows only per-model aggregates. Users cannot tell *which* user turn caused a cost spike or *which* individual LLM call had poor cache performance. This feature surfaces that granularity.

## Entry Point

Add a **"🔍 Deep Dive"** button to the session detail panel (`renderSessionDetail` in `dashboard.html`), next to the existing cost/credits display in the detail header area.

When clicked, it sends an RPC message `getSessionDeepDive` with `{ sessionId }` to the extension backend. The backend parses the JSONL log and returns per-turn and per-call data. The frontend renders it inside the same detail panel, below the existing model breakdown.

## Backend

### New RPC handler

Add a `getSessionDeepDive` case in `DashboardPanel.handleMessage()` (`src/dashboardPanel.ts`). It should call a new exported function from `sessionParser.ts`.

### New parser function

Add to `src/sessionParser.ts`:

```ts
export function parseSessionDeepDive(sessionDir: string): SessionDeepDive
```

This function reads `main.jsonl` (and `runSubagent-*.jsonl` files) and returns structured per-turn, per-call data.

### Data shape

```ts
interface CallRecord {
  /** 1-based call index within the entire session */
  seq: number;
  /** Model used */
  model: string;
  /** debugName from attrs (e.g. "panel/editAgent", "summarizeConversationHistory") */
  debugName: string;
  /** Total input tokens sent */
  inputTokens: number;
  /** Cached input tokens (from server response). -1 if field absent. */
  cachedTokens: number;
  /** Fresh (non-cached) input tokens = inputTokens - max(0, cachedTokens) */
  freshTokens: number;
  /** Cache write tokens */
  cacheWriteTokens: number;
  /** Output tokens */
  outputTokens: number;
  /** Cache hit ratio 0-100, or null if cachedTokens was absent */
  cacheHitPct: number | null;
  /** Computed cost for this single call (using pricing lookup) */
  cost: number;
  /** Whether this call is from a subagent file */
  isSubagent: boolean;
  /** Time to first token in ms (from attrs.ttft), or null */
  ttft: number | null;
  /**
   * Wall-clock timestamp of this call in milliseconds since epoch.
   * Taken from the top-level `ts` field of the JSONL entry.
   * null if the field is absent in the log.
   */
  ts: number | null;
}

interface TurnRecord {
  /** 1-based user turn number */
  turn: number;
  /** Number of LLM calls in this turn */
  calls: number;
  /** Aggregated totals for the turn */
  inputTokens: number;
  cachedTokens: number;
  freshTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  cacheHitPct: number;
  cost: number;
  /** Whether a summarization call occurred in this turn */
  hasSummarization: boolean;
  /**
   * Timestamp of the first call in this turn (ms since epoch), or null if no
   * ts fields are present in the log.
   */
  firstTs: number | null;
  /**
   * Timestamp of the last call in this turn (ms since epoch), or null.
   */
  lastTs: number | null;
  /** Individual call records */
  callRecords: CallRecord[];
}

interface SessionDeepDive {
  turns: TurnRecord[];
  totals: {
    turns: number;
    calls: number;
    inputTokens: number;
    cachedTokens: number;
    freshTokens: number;
    outputTokens: number;
    cacheHitPct: number;
    cost: number;
  };
}
```

### Parsing logic

The core loop already exists in `parseJsonlFile`. The new function should:

1. Read `main.jsonl` line by line.
2. On `user_message` entries: increment `currentTurnId`.
3. On `llm_request` entries with `status === "ok"`: extract `attrs.inputTokens`, `attrs.outputTokens`, `attrs.cachedTokens`, `attrs.cacheWriteTokens`, `attrs.model`, `attrs.debugName`, `attrs.ttft`, and the top-level `ts` field.
4. Compute `freshTokens = inputTokens - max(0, cachedTokens)` per call.
5. Compute per-call cost using the shared `computeCallCost()` helper (see **Cost calculation** below). This ensures identical results to the existing session totals.
6. Track `firstTs` and `lastTs` per turn from the `ts` field. If `ts` is absent on all entries in the log, leave both null.
7. Detect summarization calls by checking if `attrs.debugName` contains `"summarize"` (case-insensitive).
8. Group calls into `TurnRecord` arrays; aggregate sums and compute turn-level `cacheHitPct`.
9. Also process `runSubagent-*.jsonl` files. Subagent calls should be assigned to the turn that was active when the subagent was spawned (same turn tracking as existing code). Mark `isSubagent: true`.

### Cost calculation

Extract the per-call cost formula from `computeCost()` into a new **shared helper** in `src/sessionParser.ts`:

```ts
/**
 * Compute cost for a single LLM call.
 * Used by both computeCost() (aggregate) and parseSessionDeepDive() (per-call).
 */
export function computeCallCost(
  modelKey: string,
  inputTokens: number,
  cachedTokens: number,      // pass 0 if field was absent
  cacheWriteTokens: number,
  outputTokens: number,
  cacheAssumed: boolean,     // true when cachedTokens was estimated, not reported
): number
```

`computeCost()` should be refactored to call `computeCallCost()` for each model's aggregated totals rather than repeating the arithmetic inline. This guarantees that deep-dive per-call costs sum to exactly the same total as the existing session cost.

**Performance note:** This is on-demand only (not cached). For large sessions (50MB+ JSONL), this may take 1-3 seconds. The frontend should show a spinner while loading. No pre-computation or caching is needed for v1.

## Frontend

### Deep Dive button

Add inside `renderSessionDetail()` in `dashboard.html`, in the detail header next to the cost display:

```html
<button class="btn btn-sm" onclick="loadDeepDive('${sessionId}')">🔍 Deep Dive</button>
```

### Deep Dive container

Add a `<div id="deep-dive-{sessionId}">` below the model breakdown section in the detail panel. Initially empty.

### Rendering

When data arrives, render a **single table** with two row types:

1. **Turn rows** (parent) — one per user turn, showing aggregated stats. Clickable to expand/collapse.
2. **Call rows** (child) — one per LLM call within a turn. Indented and initially hidden.

#### Table columns

| Column | Turn row | Call row | Notes |
|--------|----------|----------|-------|
| **#** | Turn number (e.g. "Turn 3") | Call sequence (e.g. "3.7" = turn 3, call 7) | |
| **Time** | `firstTs` formatted as `HH:MM:SS` | `ts` formatted as `HH:MM:SS` | Show date too if session spans multiple days. Show `—` if ts is null. |
| **Calls** | Count of calls in turn | — (blank) | |
| **Input** | Sum of inputTokens | inputTokens | Format: `fmt(n)` with thousands separator |
| **Fresh** | Sum of freshTokens | freshTokens | Color: red if > 80% of input |
| **Cached** | Sum of cachedTokens | cachedTokens | |
| **Output** | Sum of outputTokens | outputTokens | |
| **Cache %** | Turn-level cache ratio | Per-call cache ratio | Color: green >90%, yellow 70-90%, red <70%. Show "N/A" if cachedTokens was -1. |
| **Cost** | Turn total cost | Per-call cost | Format: `$X.XXXX` |
| **Type** | — | debugName shortened (e.g. "editAgent", "summarize") | Flag summarization calls with ⚠️ icon |

#### Visual details

- Turn rows have **bold text** and slightly darker background (`var(--surface2)`).
- Call rows are indented with `padding-left: 32px` on the first cell.
- Turn rows start **collapsed** (call rows hidden).
- Clicking a turn row toggles its call rows visible/hidden with a ▶/▼ arrow.
- Summarization calls: show a `⚠️` icon in the Type column and optionally a tooltip: "Context summarization — may invalidate cache".
- Subagent calls: show a small `sub` badge (same style as existing `badge-gray`).
- Use existing CSS variables and classes (no new CSS files). Add any needed styles inline or in the existing `<style>` block.

#### Sorting

The table should be **sortable by column** (reuse the existing `sortable` th pattern from the sessions table). Default sort: turn number ascending (chronological, which is also time ascending when timestamps are present). Sorting by any column should reorder turn rows only; call rows always stay grouped under their parent turn.

### No-popup approach

Do NOT use a modal or popup. Render the deep-dive table inline within the detail panel, below the model breakdown. This avoids VS Code webview limitations with dialogs and keeps the UX consistent. If the user clicks "Deep Dive" again, toggle the section closed.

## Edge Cases

- **Sessions with no user_message entries**: Treat all calls as "Turn 0". Label as "Setup / System".
- **Subagent calls with no associated turn**: Assign to the last active turn, or turn 0 if none.
- **cachedTokens field absent**: Show "N/A" for cache %, don't include in aggregated cache ratio calculation. Set `cachedTokens = -1` in CallRecord.
- **Very large sessions (100+ calls)**: Render all rows; the table is lightweight. No pagination needed.
- **Multiple models in one session**: Show model name in a compact form in the Type column or as a tooltip.

## Files to modify

| File | Changes |
|------|---------|
| `src/sessionParser.ts` | Extract `computeCallCost()` shared helper from `computeCost()`. Add `CallRecord`, `TurnRecord`, `SessionDeepDive` interfaces. Add `parseSessionDeepDive()` function. Refactor `computeCost()` to delegate to `computeCallCost()`. |
| `src/dashboardPanel.ts` | Add `getSessionDeepDive` case in `handleMessage()`. Import the new function. |
| `media/dashboard.html` | Add deep-dive button in `renderSessionDetail()`. Add `loadDeepDive()` function, `renderDeepDive()` function, toggle/sort logic, and any needed CSS. |

## Out of scope (v1)

- Caching / pre-computation of deep-dive data.
- Duration / elapsed-time column between consecutive calls.
- Exporting the deep-dive table to CSV.
- Displaying user message content/snippets per turn.
- Cost-per-turn chart/visualization.
