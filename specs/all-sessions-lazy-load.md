# All Sessions — Performance & Lazy Context Loading

## Problem

Loading the "All Sessions" tab is slow, especially with a wide time window (≥7 days).

## Root Cause Analysis

### 1. N simultaneous `getSession` calls on tab open

`loadSessions()` fires one `rpc('getSession', …)` call **per session** in a `forEach` loop (no
`await`), immediately after the table renders.  
Each `getSession` call maps to `analyzeSession()` in the backend, which:

- Reads `main.jsonl` **fully** (pass 1 — `parseSession()` for token/cost stats)
- Reads `main.jsonl` **again** (pass 2 — `parseSessionContext()` for agents/skills/instructions)
- Also reads every `runSubagent-*.jsonl` in the session directory

With 30+ sessions in a 30-day window, this means 60+ full file reads happen simultaneously
at tab load.  The only data the table actually uses from these responses is
`totals.cost` and `totals.cache_ratio` — the `context` payload is discarded entirely.

### 2. Double-parse of `main.jsonl` inside `analyzeSession()`

`analyzeSession()` calls `parseSession()` and then calls `parseSessionContext()` as a separate,
independent scan of the same file.  Each call allocates its own `content.split("\n")` pass,
doubling I/O and CPU time.

### 3. No caching of full session data in the frontend

When a row is clicked, `selectSession()` fires another `rpc('getSession', …)` even though the
call was already made (and resolved) during bulk cost loading.  `sessionsCache` only stores
`_cost` and `_cache`, so the full `SessionAnalysis` is fetched twice.

### 4. `SessionContext` is NOT the per-turn Deep Dive

The existing **🔍 Deep Dive** button (`getSessionDeepDive` → `parseSessionDeepDive`) is already
lazy (on-click only). ✓

The slow part is the **`SessionContext`** block (agents/skills/instructions tab panel) which is
always parsed inside `analyzeSession()`, consumed only when a specific row is expanded.

---

## Proposed Plan

### Phase 1 — Add lightweight `getSessionCost` RPC  *(backend + frontend)*

**Goal**: Make the bulk table-fill fast by skipping context parsing entirely.

**Backend** (`src/dashboardPanel.ts`):
- Add a new `case "getSessionCost"` handler that calls a new helper
  `analyzeSessionCost(session)` which runs only `parseSession()` + `modelStatsToJson()` and
  returns `{ id, totals: { cost, cache_ratio } }` — no `context`, no model details.

**Frontend** (`media/dashboard.js`):
- In `loadSessions()`, replace `rpc('getSession', …)` with `rpc('getSessionCost', …)`.
- The `.then()` callback already only reads `data?.totals?.cost` and `data?.totals?.cache_ratio`
  so no other frontend change is needed.

**Expected impact**: halves the cost-column fill time (eliminates the `parseSessionContext` pass
and the second full `main.jsonl` read for every session in the list).

---

### Phase 2 — Lazy-load `SessionContext`  *(backend + frontend)*

**Goal**: Session row expansion renders instantly; context tab appears ~100 ms later without
blocking the detail panel.

**Backend** (`src/sessionParser.ts` + `src/dashboardPanel.ts`):
- Remove `context: parseSessionContext(session.path)` from `analyzeSession()`.  
  `SessionAnalysis.context` becomes `context?: SessionContext` (optional) and is `undefined`
  unless explicitly requested.
- Add a new `case "getSessionContext"` RPC handler that calls
  `parseSessionContext(session.path)` and returns just the context object.

**Frontend** (`media/dashboard.js`):
- `renderSessionDetail(data)` renders without the context tab panel.  Add a placeholder
  `<div id="ctx-pending-${id}"><div class="loading">…</div></div>` in the position where the
  context tabs would appear.
- After `detailTr` is written to the DOM, issue `rpc('getSessionContext', { sessionId: id })` in
  the background and replace the placeholder when the response arrives.
- If context data is already present in `sessionsCache` (from a previous expand), skip the RPC.

---

### Phase 3 — Cache full session data in the frontend  *(frontend only)*

**Goal**: Re-expanding a previously opened row is instant.

**Frontend** (`media/dashboard.js`):
- In `sessionsCache`, add an `_analysis` field (initially `null`).
- In `selectSession()`:  
  - If `s._analysis` is populated, call `renderSessionDetail(s._analysis)` synchronously —
    no spinner, no RPC.
  - Otherwise fetch via `rpc('getSession', …)` and store the result in `s._analysis`.
- Similarly, store the context in `s._ctx` after Phase 2's lazy fetch, so repeated
  expands don't re-request it.

---

### Optional — Phase 4 — Single-pass `main.jsonl` read  *(backend)*

**Goal**: Eliminate the double file read inside a single `analyzeSession()` call (relevant when
the full analysis including context is needed — e.g. Latest Session tab).

Merge `parseSession()` and `parseSessionContext()` into a unified `parseSessionFull()` that
reads `main.jsonl` once and returns both `ModelStats` and `SessionContext` in a single pass.
`analyzeSession()` calls this merged function instead of calling both separately.

This is lower priority because Phase 1 already prevents `parseSessionContext` from being called
during bulk table loading, and Phase 2 makes the context lazy.  Phase 4 is a pure backend
clean-up that benefits only the Latest Session tab and the explicit row-expand path.

---

## Summary

| Phase | What changes | Benefit |
|-------|-------------|---------|
| 1 | New `getSessionCost` RPC; `loadSessions` uses it | Eliminates `parseSessionContext` for every row in the table |
| 2 | Context removed from `analyzeSession`; new `getSessionContext` RPC; lazy render in detail panel | Context never blocks row expansion |
| 3 | `sessionsCache._analysis` / `_ctx` fields | Re-expand is instant; zero duplicate RPCs |
| 4 | Merge `parseSession` + `parseSessionContext` into single pass | Halves file I/O for full analysis |

Phases 1–3 together should reduce "All Sessions" initial load from O(N × 2 file-reads) to
O(N × 1 file-read), and make row expansion non-blocking.
