const path = require('path');
const { loadPricing, findPricing, canonicalModel, vendorFor } = require('./out/pricing');
const { parseSession, analyzeSession, analyzeAggregate } = require('./out/sessionParser');
const { findAllSessions, getLatestSession } = require('./out/sessionDiscovery');
const fs = require('fs');

async function run() {
  // ── Test 1: Pricing loads ────────────────────────────────────────────
  const source = await loadPricing(__dirname);
  console.log('✓ Pricing source:', source);

  // ── Test 2: Known model lookup ───────────────────────────────────────
  const models = ['claude-sonnet-4.6', 'gpt-4.1', 'gpt-4o-mini-2024-07-18', 'gemini-2.5-pro', 'gpt-5'];
  for (const m of models) {
    const p = findPricing(m);
    console.log(p ? '  ✓ Pricing found: ' + m : '  ✗ MISSING: ' + m);
  }

  // ── Test 3: Alias matching (log emits versioned names) ───────────────
  const aliases = [
    'claude-sonnet-4-6-20250501',
    'claude-sonnet-4.6-20250501',
    'gpt-4o',
  ];
  for (const a of aliases) {
    const canon = canonicalModel(a);
    const p = findPricing(a);
    console.log(p ? '  ✓ Alias ok: ' + a + ' -> ' + canon : '  ✗ Alias fail: ' + a);
  }

  // ── Test 4: Vendor detection ─────────────────────────────────────────
  const vendorTests = [
    ['claude-sonnet-4.6', 'Anthropic (Claude)'],
    ['gpt-5', 'OpenAI (GPT)'],
    ['gemini-2.5-pro', 'Google (Gemini)'],
    ['unknown-model', 'Other'],
  ];
  for (const [model, expected] of vendorTests) {
    const v = vendorFor(model);
    console.log(v === expected ? '  ✓ Vendor: ' + model + ' = ' + v : '  ✗ Vendor mismatch: ' + model + ' got ' + v + ' expected ' + expected);
  }

  // ── Test 5: Session discovery ────────────────────────────────────────
  const sessions = findAllSessions(168); // last 7 days
  console.log('✓ Sessions found (7 days):', sessions.length);
  if (sessions.length > 0) {
    const s = sessions[0];
    console.log('  Latest:', s.date, '|', s.workspace_name, '|', s.session_title.slice(0, 40));

    // ── Test 6: Parse + cost a real session ──────────────────────────
    const stats = parseSession(s.path);
    const modelCount = stats.size;
    console.log('  ✓ Models in session:', modelCount);

    const analysis = analyzeSession(s);
    const cost = analysis.totals.cost;
    const calls = analysis.totals.calls;
    console.log('  ✓ Cost: $' + cost.toFixed(6) + '  Calls: ' + calls);
    if (cost === 0 && calls > 0) {
      console.log('  ✗ WARNING: calls found but cost is 0 - pricing lookup may be broken');
    }

    // ── Test 7: Model results ────────────────────────────────────────
    for (const m of analysis.models) {
      if (m.warning) {
        console.log('  ✗ No pricing for model:', m.model);
      } else {
        console.log('  ✓ Model:', m.model, '| cost: $' + m.cost.toFixed(6), '| calls:', m.calls);
      }
    }
  } else {
    console.log('  (no sessions in last 7 days to test against)');
  }

  // ── Test 8: Aggregate ────────────────────────────────────────────────
  const agg = analyzeAggregate(168);
  if (agg) {
    console.log('✓ Aggregate: sessions=' + agg.sessions_count + ' cost=$' + agg.totals.cost.toFixed(4));
  } else {
    console.log('  (no aggregate data)');
  }
}

run().catch(e => {
  console.error('✗ Test failed:', e.message);
  console.error(e.stack);
});
