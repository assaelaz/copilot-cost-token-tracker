/**
 * JSONL parsing and cost computation.
 * Ported from session-cost.py parse_session / compute_cost.
 */

import * as fs from "fs";
import * as path from "path";
import { canonicalModel, findPricing, vendorFor, ASSUMED_CACHE_RATIO } from "./pricing";
import { SessionRecord, findAllSessions, getLatestSession, findSessionById } from "./sessionDiscovery";

// ── Types ──────────────────────────────────────────────────────────────

export interface CallRecord {
  /** 1-based call index within the entire session */
  seq: number;
  /** Canonical model key */
  model: string;
  /** debugName from attrs (e.g. "panel/editAgent", "summarizeConversationHistory") */
  debugName: string;
  /** Total input tokens sent */
  inputTokens: number;
  /** Cached input tokens from server response. -1 if field absent. */
  cachedTokens: number;
  /** Fresh (non-cached) input tokens = inputTokens - max(0, cachedTokens) */
  freshTokens: number;
  /** Cache write tokens */
  cacheWriteTokens: number;
  /** Output tokens */
  outputTokens: number;
  /** Cache hit ratio 0-100, or null if cachedTokens was absent */
  cacheHitPct: number | null;
  /** Computed cost for this single call */
  cost: number;
  /** Whether this call is from a subagent file */
  isSubagent: boolean;
  /** Time to first token in ms (from attrs.ttft), or null */
  ttft: number | null;
  /** Wall-clock timestamp in ms since epoch (top-level `ts` field), or null */
  ts: number | null;
}

export interface TurnRecord {
  /** 1-based user turn number. 0 = before first user message (Setup/System). */
  turn: number;
  /** Number of LLM calls in this turn */
  calls: number;
  /** Aggregated totals */
  inputTokens: number;
  cachedTokens: number;
  freshTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** Turn-level cache hit ratio 0-100 */
  cacheHitPct: number;
  cost: number;
  /** Whether a summarization call occurred in this turn */
  hasSummarization: boolean;
  /** Timestamp of first call in this turn (ms), or null */
  firstTs: number | null;
  /** Timestamp of last call in this turn (ms), or null */
  lastTs: number | null;
  /** Individual call records */
  callRecords: CallRecord[];
  /** First user message text for this turn, or null */
  userMessage: string | null;
}

export interface SessionDeepDive {
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

interface ModelStats {
  calls: number;
  main_calls: number;
  subagent_calls: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  any_cached_field_seen: boolean;
  cache_write_estimated: boolean;
  cache_assumed: boolean;
  user_turns: number;
  _user_turn_ids: Set<number>;
}

export interface ModelResult {
  model: string;
  vendor: string;
  calls: number;
  main_calls: number;
  subagent_calls: number;
  user_turns: number;
  input_tokens: number;
  fresh_input: number;
  cached_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  cost: number;
  has_cache_write: boolean;
  cache_assumed: boolean;
  cache_write_estimated: boolean;
  warning?: string;
  pricing?: {
    input: number;
    cached_input: number;
    cache_write: number;
    output: number;
  };
}

export interface SessionAnalysis {
  session: {
    id: string;
    ts: number;
    date: string;
    workspace_name: string;
    session_title: string;
  };
  models: ModelResult[];
  totals: {
    calls: number;
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
    cache_ratio: number;
    cost: number;
  };
}

// ── Parsing ────────────────────────────────────────────────────────────

function newStats(): ModelStats {
  return {
    calls: 0, main_calls: 0, subagent_calls: 0,
    input_tokens: 0, output_tokens: 0,
    cached_tokens: 0, cache_write_tokens: 0,
    any_cached_field_seen: false, cache_write_estimated: false,
    cache_assumed: false, user_turns: 0,
    _user_turn_ids: new Set(),
  };
}

function parseJsonlFile(
  filePath: string,
  stats: Map<string, ModelStats>,
  isSubagent: boolean,
): void {
  if (!fs.existsSync(filePath)) { return; }
  let content: string;
  try { content = fs.readFileSync(filePath, "utf-8"); } catch { return; }

  let currentTurnId = 0;

  for (const line of content.split("\n")) {
    if (!line.trim()) { continue; }
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }

    const etype: string = entry.type || "";

    if (!isSubagent && etype === "user_message") {
      currentTurnId++;
      continue;
    }

    if (etype !== "llm_request" || entry.status !== "ok") { continue; }

    const attrs = entry.attrs || {};
    const model: string = attrs.model || "";
    if (!model) { continue; }

    const key = canonicalModel(model);
    if (!stats.has(key)) { stats.set(key, newStats()); }
    const s = stats.get(key)!;

    s.calls++;
    if (isSubagent) { s.subagent_calls++; } else { s.main_calls++; }

    const inputTok = parseInt(attrs.inputTokens || "0", 10);
    const outputTok = parseInt(attrs.outputTokens || "0", 10);
    const cwTok = parseInt(attrs.cacheWriteTokens || "0", 10);
    const hasCachedField = "cachedTokens" in attrs;
    const cachedTok = parseInt(attrs.cachedTokens || "0", 10);

    s.input_tokens += inputTok;
    s.output_tokens += outputTok;
    s.cached_tokens += cachedTok;
    s.cache_write_tokens += cwTok;

    if (hasCachedField) { s.any_cached_field_seen = true; }
    if (cwTok === 0 && hasCachedField && inputTok > 0) { s.cache_write_estimated = true; }

    if (!isSubagent && currentTurnId > 0) {
      s._user_turn_ids.add(currentTurnId);
    }
  }
}

export function parseSession(sessionDir: string): Map<string, ModelStats> {
  const stats = new Map<string, ModelStats>();

  // Pass 1: main.jsonl
  parseJsonlFile(path.join(sessionDir, "main.jsonl"), stats, false);

  // Pass 2: sub-agent files
  try {
    for (const file of fs.readdirSync(sessionDir)) {
      if (file === "main.jsonl") { continue; }
      if (!file.startsWith("runSubagent-") || !file.endsWith(".jsonl")) { continue; }
      parseJsonlFile(path.join(sessionDir, file), stats, true);
    }
  } catch { /* ignore */ }

  // Materialise user_turns
  for (const s of stats.values()) {
    s.user_turns = s._user_turn_ids.size;
    s._user_turn_ids = new Set(); // clear
  }

  return stats;
}

// ── Cost computation ───────────────────────────────────────────────────

/**
 * Compute cost for a single LLM call.
 * Used by both computeCost() (aggregate) and parseSessionDeepDive() (per-call).
 * @param cachedTokens   Already-resolved cached token count (pass 0 when field is absent)
 * @param cacheAssumed   True when cachedTokens was estimated, not reported (informational)
 */
export function computeCallCost(
  modelKey: string,
  inputTokens: number,
  cachedTokens: number,
  cacheWriteTokens: number,
  outputTokens: number,
  _cacheAssumed: boolean,
): number {
  const pricing = findPricing(modelKey);
  if (!pricing) { return 0; }
  const hasCacheWrite = pricing.cache_write !== undefined;
  const freshInput = Math.max(0, inputTokens - cachedTokens - cacheWriteTokens);
  let cost = freshInput * pricing.input / 1_000_000;
  cost += cachedTokens * pricing.cached_input / 1_000_000;
  if (hasCacheWrite) {
    cost += cacheWriteTokens * (pricing.cache_write || 0) / 1_000_000;
  }
  cost += outputTokens * pricing.output / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export function computeCost(modelKey: string, s: ModelStats): ModelResult {
  const pricing = findPricing(modelKey);
  if (!pricing) {
    return {
      model: modelKey, vendor: vendorFor(modelKey),
      calls: s.calls, main_calls: s.main_calls, subagent_calls: s.subagent_calls,
      user_turns: s.user_turns, input_tokens: s.input_tokens,
      fresh_input: s.input_tokens, cached_tokens: 0, cache_write_tokens: 0,
      output_tokens: s.output_tokens, cost: 0, has_cache_write: false,
      cache_assumed: false, cache_write_estimated: false,
      warning: `No pricing data found for model '${modelKey}' — cost excluded.`,
    };
  }

  const hasCacheWrite = pricing.cache_write !== undefined;
  let cachedTok = s.cached_tokens;
  const cachingNotTracked = !s.any_cached_field_seen;
  const cacheAssumed = (cachingNotTracked && hasCacheWrite) || s.cache_assumed;

  if (cachingNotTracked && hasCacheWrite) {
    cachedTok = Math.floor(s.input_tokens * ASSUMED_CACHE_RATIO);
  }

  const freshInput = Math.max(0, s.input_tokens - cachedTok - s.cache_write_tokens);
  const cost = computeCallCost(modelKey, s.input_tokens, cachedTok, s.cache_write_tokens, s.output_tokens, cacheAssumed);

  return {
    model: modelKey,
    vendor: vendorFor(modelKey),
    calls: s.calls,
    main_calls: s.main_calls,
    subagent_calls: s.subagent_calls,
    user_turns: s.user_turns,
    input_tokens: s.input_tokens,
    fresh_input: freshInput,
    cached_tokens: cachedTok,
    cache_write_tokens: s.cache_write_tokens,
    output_tokens: s.output_tokens,
    cost,
    has_cache_write: hasCacheWrite,
    cache_assumed: cacheAssumed,
    cache_write_estimated: s.cache_write_estimated,
    pricing: {
      input: pricing.input,
      cached_input: pricing.cached_input,
      cache_write: pricing.cache_write || 0,
      output: pricing.output,
    },
  };
}

// ── High-level API (used by webview message handler) ───────────────────

function modelStatsToJson(stats: Map<string, ModelStats>): ModelResult[] {
  const results: ModelResult[] = [];
  for (const [key, s] of stats) {
    results.push(computeCost(key, s));
  }
  return results.sort((a, b) => b.cost - a.cost);
}

function sessionToJson(s: SessionRecord) {
  return {
    id: s.id, ts: s.ts, date: s.date,
    last_ts: s.last_ts, last_date: s.last_date,
    workspace_name: s.workspace_name,
    session_title: s.session_title,
  };
}

export function analyzeSession(session: SessionRecord): SessionAnalysis {
  const stats = parseSession(session.path);
  const models = modelStatsToJson(stats);
  const valid = models.filter(m => !m.warning);
  const totalCost = valid.reduce((sum, m) => sum + m.cost, 0);
  const totalInput = valid.reduce((sum, m) => sum + m.input_tokens, 0);
  const totalOutput = valid.reduce((sum, m) => sum + m.output_tokens, 0);
  const totalCached = valid.reduce((sum, m) => sum + m.cached_tokens, 0);
  const totalCalls = valid.reduce((sum, m) => sum + m.calls, 0);

  return {
    session: sessionToJson(session),
    models,
    totals: {
      calls: totalCalls,
      input_tokens: totalInput,
      output_tokens: totalOutput,
      cached_tokens: totalCached,
      cache_ratio: totalInput ? Math.round(1000 * totalCached / totalInput) / 10 : 0,
      cost: Math.round(totalCost * 1_000_000) / 1_000_000,
    },
  };
}

export function analyzeAggregate(hours: number, prefiltered?: ReturnType<typeof findAllSessions>) {
  const sessions = prefiltered ?? findAllSessions(hours);
  if (!sessions.length) { return undefined; }

  const grand = new Map<string, ModelStats>();

  for (const s of sessions) {
    const stats = parseSession(s.path);
    for (const [model, st] of stats) {
      if (!grand.has(model)) {
        grand.set(model, {
          calls: 0, main_calls: 0, subagent_calls: 0,
          input_tokens: 0, output_tokens: 0,
          cached_tokens: 0, cache_write_tokens: 0,
          any_cached_field_seen: false, cache_write_estimated: false,
          cache_assumed: false, user_turns: 0, _user_turn_ids: new Set(),
        });
      }
      const g = grand.get(model)!;
      g.calls += st.calls;
      g.input_tokens += st.input_tokens;
      g.output_tokens += st.output_tokens;
      g.cache_write_tokens += st.cache_write_tokens;
      if (st.cache_write_estimated) { g.cache_write_estimated = true; }
      if (st.any_cached_field_seen) {
        g.any_cached_field_seen = true;
        g.cached_tokens += st.cached_tokens;
      } else {
        const pricing = findPricing(model);
        if (pricing && pricing.cache_write !== undefined) {
          g.cached_tokens += Math.floor(st.input_tokens * ASSUMED_CACHE_RATIO);
          g.cache_assumed = true;
          g.any_cached_field_seen = true;
        } else {
          g.cached_tokens += st.cached_tokens;
        }
      }
      g.user_turns += st.user_turns;
    }
  }

  const models = modelStatsToJson(grand);
  const valid = models.filter(m => !m.warning);
  const totalCost = valid.reduce((sum, m) => sum + m.cost, 0);
  const totalInput = valid.reduce((sum, m) => sum + m.input_tokens, 0);
  const totalOutput = valid.reduce((sum, m) => sum + m.output_tokens, 0);
  const totalCached = valid.reduce((sum, m) => sum + m.cached_tokens, 0);
  const totalCalls = valid.reduce((sum, m) => sum + m.calls, 0);

  return {
    sessions_count: sessions.length,
    hours,
    models,
    totals: {
      calls: totalCalls,
      input_tokens: totalInput,
      output_tokens: totalOutput,
      cached_tokens: totalCached,
      cache_ratio: totalInput ? Math.round(1000 * totalCached / totalInput) / 10 : 0,
      cost: Math.round(totalCost * 1_000_000) / 1_000_000,
    },
  };
}

export { findAllSessions, getLatestSession, findSessionById };

// ── Deep Dive ──────────────────────────────────────────────────────────

export function parseSessionDeepDive(sessionDir: string): SessionDeepDive {
  let currentTurnId = 0;
  let seqCounter = 0;
  const turnMap = new Map<number, TurnRecord>();

  function ensureTurn(id: number): TurnRecord {
    if (!turnMap.has(id)) {
      turnMap.set(id, {
        turn: id,
        calls: 0,
        inputTokens: 0,
        cachedTokens: 0,
        freshTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        cacheHitPct: 0,
        cost: 0,
        hasSummarization: false,
        firstTs: null,
        lastTs: null,
        callRecords: [],
        userMessage: null,
      });
    }
    return turnMap.get(id)!;
  }

  function processLine(line: string, isSubagent: boolean, turnId: number): void {
    if (!line.trim()) { return; }
    let entry: any;
    try { entry = JSON.parse(line); } catch { return; }

    const etype: string = entry.type || "";

    if (!isSubagent && etype === "user_message") {
      currentTurnId++;
      const userText = ((entry.attrs?.content as string) || "").replace(/\s+/g, " ").trim();
      if (userText) {
        const turn = ensureTurn(currentTurnId);
        if (!turn.userMessage) {
          turn.userMessage = userText.length > 300 ? userText.slice(0, 297) + "…" : userText;
        }
      }
      return;
    }

    if (etype !== "llm_request" || entry.status !== "ok") { return; }

    const attrs = entry.attrs || {};
    const model: string = attrs.model || "";
    if (!model) { return; }

    const key = canonicalModel(model);
    const inputTokens = parseInt(attrs.inputTokens ?? "0", 10) || 0;
    const outputTokens = parseInt(attrs.outputTokens ?? "0", 10) || 0;
    const cacheWriteTokens = parseInt(attrs.cacheWriteTokens ?? "0", 10) || 0;
    const hasCachedField = "cachedTokens" in attrs;
    const rawCached = hasCachedField ? (parseInt(attrs.cachedTokens ?? "0", 10) || 0) : -1;
    // freshTokens for display: inputTokens - max(0, cachedTokens)
    const freshTokens = inputTokens - Math.max(0, rawCached);
    const debugName: string = attrs.debugName || "";
    const ttft: number | null = attrs.ttft != null ? Number(attrs.ttft) : null;
    const ts: number | null = entry.ts != null ? Number(entry.ts) : null;

    const cacheHitPct: number | null = hasCachedField
      ? (inputTokens > 0 ? Math.round(1000 * Math.max(0, rawCached) / inputTokens) / 10 : 0)
      : null;

    // Per-call cost: use 0 for cachedTokens when absent (no per-call estimation)
    const cachedForCost = hasCachedField ? Math.max(0, rawCached) : 0;
    const cost = computeCallCost(key, inputTokens, cachedForCost, cacheWriteTokens, outputTokens, false);

    seqCounter++;
    const callRecord: CallRecord = {
      seq: seqCounter,
      model: key,
      debugName,
      inputTokens,
      cachedTokens: rawCached,
      freshTokens,
      cacheWriteTokens,
      outputTokens,
      cacheHitPct,
      cost,
      isSubagent,
      ttft,
      ts,
    };

    const turn = ensureTurn(turnId);
    turn.calls++;
    turn.inputTokens += inputTokens;
    turn.cachedTokens += Math.max(0, rawCached);
    turn.freshTokens += freshTokens;
    turn.cacheWriteTokens += cacheWriteTokens;
    turn.outputTokens += outputTokens;
    turn.cost += cost;
    if (debugName.toLowerCase().includes("summarize")) {
      turn.hasSummarization = true;
    }
    if (ts != null) {
      if (turn.firstTs === null || ts < turn.firstTs) { turn.firstTs = ts; }
      if (turn.lastTs === null || ts > turn.lastTs) { turn.lastTs = ts; }
    }
    turn.callRecords.push(callRecord);
  }

  // Pass 1: main.jsonl (tracks currentTurnId)
  const mainFile = path.join(sessionDir, "main.jsonl");
  if (fs.existsSync(mainFile)) {
    let content = "";
    try { content = fs.readFileSync(mainFile, "utf-8"); } catch { /* ignore */ }
    for (const line of content.split("\n")) {
      processLine(line, false, currentTurnId);
    }
  }

  // Pass 2: subagent files — assign to the turn active at end of main.jsonl
  const subagentTurnId = currentTurnId;
  try {
    for (const file of fs.readdirSync(sessionDir)) {
      if (file === "main.jsonl") { continue; }
      if (!file.startsWith("runSubagent-") || !file.endsWith(".jsonl")) { continue; }
      let content = "";
      try { content = fs.readFileSync(path.join(sessionDir, file), "utf-8"); } catch { continue; }
      for (const line of content.split("\n")) {
        processLine(line, true, subagentTurnId);
      }
    }
  } catch { /* ignore */ }

  // Finalise turns: compute turn-level cacheHitPct and round costs
  const turns = [...turnMap.values()].sort((a, b) => a.turn - b.turn);
  for (const t of turns) {
    // Cache hit ratio: only from calls where cached field was reported
    const reported = t.callRecords.filter(c => c.cacheHitPct !== null);
    if (reported.length > 0) {
      const repInput = reported.reduce((s, c) => s + c.inputTokens, 0);
      const repCached = reported.reduce((s, c) => s + Math.max(0, c.cachedTokens), 0);
      t.cacheHitPct = repInput > 0 ? Math.round(1000 * repCached / repInput) / 10 : 0;
    } else {
      t.cacheHitPct = 0;
    }
    t.cost = Math.round(t.cost * 1_000_000) / 1_000_000;
  }

  // Grand totals
  const allCalls = turns.flatMap(t => t.callRecords);
  const totalInputTokens = turns.reduce((s, t) => s + t.inputTokens, 0);
  const totalCachedTokens = turns.reduce((s, t) => s + t.cachedTokens, 0);
  const totalFreshTokens = turns.reduce((s, t) => s + t.freshTokens, 0);
  const totalOutputTokens = turns.reduce((s, t) => s + t.outputTokens, 0);
  const totalCost = Math.round(turns.reduce((s, t) => s + t.cost, 0) * 1_000_000) / 1_000_000;
  const reportedCalls = allCalls.filter(c => c.cacheHitPct !== null);
  const repTotalInput = reportedCalls.reduce((s, c) => s + c.inputTokens, 0);
  const repTotalCached = reportedCalls.reduce((s, c) => s + Math.max(0, c.cachedTokens), 0);
  const totalCacheHitPct = repTotalInput > 0 ? Math.round(1000 * repTotalCached / repTotalInput) / 10 : 0;

  return {
    turns,
    totals: {
      turns: turns.length,
      calls: allCalls.length,
      inputTokens: totalInputTokens,
      cachedTokens: totalCachedTokens,
      freshTokens: totalFreshTokens,
      outputTokens: totalOutputTokens,
      cacheHitPct: totalCacheHitPct,
      cost: totalCost,
    },
  };
}
