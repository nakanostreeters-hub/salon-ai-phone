#!/usr/bin/env node
// ============================================================
// scripts/init-mq-levels.js
// Maikon Quest Phase 0 — 全顧客への初回 Lv/Exp/動物/状態計算バッチ
//
// 実行モード:
//   node scripts/init-mq-levels.js --sample        … karte_no 9215 含む5人でdry-run
//   node scripts/init-mq-levels.js --dry-run       … 全顧客を計算のみ（DB書き込みなし）で分布出力
//   node scripts/init-mq-levels.js --commit        … 全顧客をDBに書き込み
//
//   --limit N  （dry-run / commit で対象を先頭N件に絞る。テスト用）
//
// 仮想データ厳禁。すべて実DB（customers テーブル）から読み込み、
// computeCustomerQuest で算出した値で更新する。
// ============================================================
'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const { createClient } = require('@supabase/supabase-js');
const { computeCustomerQuest } = require('../services/questEngine');

// ---------- args --------------------------------------------------------
const args = process.argv.slice(2);
const MODE = args.includes('--commit')
  ? 'commit'
  : args.includes('--sample')
    ? 'sample'
    : 'dry-run';
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : null;

// ---------- supabase ----------------------------------------------------
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL / (SERVICE_ROLE_KEY|ANON_KEY) が未設定');
  process.exit(1);
}
const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------- helpers -----------------------------------------------------
function fmtPct(n, total) {
  if (!total) return '0.0%';
  return ((n / total) * 100).toFixed(1) + '%';
}

function bucketLevel(lv) {
  if (lv <= 10) return '1-10';
  if (lv <= 30) return '11-30';
  if (lv <= 50) return '31-50';
  return '51+';
}

async function fetchAllCustomers() {
  const pageSize = 1000;
  let from = 0;
  const all = [];
  while (true) {
    const { data, error } = await supabase
      .from('customers')
      .select('id, karte_no, customer_name, visit_count, first_visit_at, last_visit_at, customer_segment')
      .order('karte_no', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`fetch customers: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
    if (LIMIT && all.length >= LIMIT) break;
  }
  return LIMIT ? all.slice(0, LIMIT) : all;
}

async function updateCustomerBatch(rows, now) {
  // Supabase UPDATE は WHERE 必須。1レコードずつ update で投げる（並列は意図的に絞る）。
  const CONCURRENCY = 16;
  let ok = 0;
  let ng = 0;
  const firstErrors = [];
  const queue = rows.slice();
  async function worker() {
    while (queue.length) {
      const r = queue.shift();
      const { error } = await supabase
        .from('customers')
        .update({
          mq_level: r.mq_level,
          mq_experience: r.mq_experience,
          mq_animal: r.mq_animal,
          mq_personality: r.mq_personality,
          mq_state: r.mq_state,
          updated_at: now,
        })
        .eq('id', r.id);
      if (error) {
        ng++;
        if (firstErrors.length < 5) firstErrors.push(`id=${r.id}: ${error.message}`);
      } else {
        ok++;
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { ok, ng, firstErrors };
}

// ---------- main --------------------------------------------------------
async function main() {
  const started = Date.now();
  const now = new Date();

  console.log('[MQ-INIT] mode:', MODE, LIMIT ? `(limit=${LIMIT})` : '');
  console.log('[MQ-INIT] fetching customers …');
  const customers = await fetchAllCustomers();
  console.log(`[MQ-INIT] loaded ${customers.length} customers`);

  // --- sample mode: 9215 + 周辺4人 ---
  if (MODE === 'sample') {
    const targets = [9215, 1, 2, 3, 4]; // 9215 + 先頭から数人。存在しないものは自動で別の顧客を補填
    const byKarte = new Map(customers.map((c) => [c.karte_no, c]));
    const picks = [];
    for (const k of targets) if (byKarte.has(k)) picks.push(byKarte.get(k));
    // 足りなければ先頭から埋める
    for (const c of customers) {
      if (picks.length >= 5) break;
      if (!picks.find((p) => p.id === c.id)) picks.push(c);
    }

    console.log('\n[MQ-INIT] サンプル5人の計算結果');
    console.log('karte_no | name          | visits | first_visit | last_visit  | Lv  | Exp   | animal   | personality | state    | segment');
    console.log('---------+---------------+--------+-------------+-------------+-----+-------+----------+-------------+----------+---------');
    for (const c of picks) {
      const q = computeCustomerQuest(c, now);
      const first = c.first_visit_at ? c.first_visit_at.slice(0, 10) : '         -';
      const last  = c.last_visit_at  ? c.last_visit_at.slice(0, 10)  : '         -';
      const name = (c.customer_name || '').padEnd(13, ' ').slice(0, 13);
      console.log(
        `${String(c.karte_no).padStart(8)} | ${name} | ${String(c.visit_count || 0).padStart(6)} | ${first} | ${last} | ${String(q.mq_level).padStart(3)} | ${String(q.mq_experience).padStart(5)} | ${q.mq_animal.padEnd(8)} | ${(q.mq_personality||'').padEnd(11)} | ${(q.mq_state||'').padEnd(8)} | ${c.customer_segment || ''}`
      );
    }
    console.log(`\n[MQ-INIT] done in ${((Date.now() - started) / 1000).toFixed(2)}s`);
    return;
  }

  // --- dry-run / commit: 全顧客を計算 ---
  const computed = customers.map((c) => {
    const q = computeCustomerQuest(c, now);
    return { id: c.id, karte_no: c.karte_no, ...q };
  });

  // 分布集計
  const lvBuckets = { '1-10': 0, '11-30': 0, '31-50': 0, '51+': 0 };
  const animalCount = {};
  const stateCount = {};
  let lvMax = 0;
  let expMax = 0;
  for (const r of computed) {
    lvBuckets[bucketLevel(r.mq_level)]++;
    animalCount[r.mq_animal] = (animalCount[r.mq_animal] || 0) + 1;
    stateCount[r.mq_state] = (stateCount[r.mq_state] || 0) + 1;
    if (r.mq_level > lvMax) lvMax = r.mq_level;
    if (r.mq_experience > expMax) expMax = r.mq_experience;
  }
  const total = computed.length;

  // DB書き込み
  let writeResult = null;
  if (MODE === 'commit') {
    console.log(`[MQ-INIT] writing ${total} rows to DB …`);
    writeResult = await updateCustomerBatch(computed, now.toISOString());
    console.log(`[MQ-INIT] write done: ok=${writeResult.ok}, ng=${writeResult.ng}`);
    if (writeResult.firstErrors.length) {
      console.log('  first errors:');
      writeResult.firstErrors.forEach((e) => console.log('   -', e));
    }
  } else {
    console.log('[MQ-INIT] DRY-RUN — DBへの書き込みはスキップしました');
  }

  console.log('\n==== 全顧客 Maikon Quest 分布サマリー ====');
  console.log(`対象: ${total} 人   Lv最大: ${lvMax}   Exp最大: ${expMax}`);

  console.log('\n[Lv分布]');
  for (const k of ['1-10', '11-30', '31-50', '51+']) {
    console.log(`  Lv ${k.padEnd(5)} : ${String(lvBuckets[k]).padStart(6)} 人 (${fmtPct(lvBuckets[k], total)})`);
  }

  console.log('\n[動物分布]');
  Object.entries(animalCount)
    .sort((a, b) => b[1] - a[1])
    .forEach(([a, n]) =>
      console.log(`  ${a.padEnd(8)} : ${String(n).padStart(6)} 人 (${fmtPct(n, total)})`),
    );

  console.log('\n[じょうたい分布]');
  Object.entries(stateCount)
    .sort((a, b) => b[1] - a[1])
    .forEach(([s, n]) =>
      console.log(`  ${(s||'(null)').padEnd(8)} : ${String(n).padStart(6)} 人 (${fmtPct(n, total)})`),
    );

  console.log(`\n[MQ-INIT] done in ${((Date.now() - started) / 1000).toFixed(2)}s`);
}

main().catch((err) => {
  console.error('[MQ-INIT] FATAL:', err);
  process.exit(1);
});
