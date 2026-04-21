// scripts/import-visits-from-csv.js
// CSV (data/来店記録データ.csv + data/来店記録施術_店販データ.csv) から
// Supabase visits テーブルへデータを移行する。
//
// 使い方:
//   node scripts/import-visits-from-csv.js --dry-run   # 件数チェックのみ
//   node scripts/import-visits-from-csv.js --execute   # 本実行 (UPSERT)
//
// 必要な環境変数 (execute時):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   (RLSが有効なため anon key では書き込めません)
//
// UPSERT キー: visit_record_no (UNIQUE制約)
//   ※ スキーマに visit_date カラムは存在しないため、POS由来の
//     visit_record_no を自然キーとして採用。

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { createClient } = require('@supabase/supabase-js');

const DATA_DIR = path.join(__dirname, '..', 'data');
const VISITS_CSV = path.join(DATA_DIR, '来店記録データ.csv');
const TREATMENTS_CSV = path.join(DATA_DIR, '来店記録施術_店販データ.csv');
const SALON_ID = 'premier-models';
const BATCH_SIZE = 200;

const VALID_SEGMENTS = ['新規失客', '固定失客', '固定', '', '新規'];

const mode = process.argv.includes('--execute') ? 'execute' : 'dry-run';

function readCsv(p) {
  return parse(fs.readFileSync(p), { columns: true, bom: true, skip_empty_lines: true });
}

function toInt(v) {
  if (v === '' || v == null) return null;
  const n = parseInt(String(v).replace(/,/g, ''), 10);
  return Number.isNaN(n) ? null : n;
}

function toTs(v) {
  if (!v) return null;
  return String(v).replace(' ', 'T') + '+09:00';
}

function buildTreatmentDetailMap(rows) {
  const byVisit = new Map();
  for (const r of rows) {
    const vr = toInt(r['来店記録番号']);
    if (!vr) continue;
    const cat = [r['大カテゴリ'], r['小カテゴリ']].filter(Boolean).join('/');
    const name = r['名前'] || '';
    const qty = r['数量'] || '';
    const amt = r['売上(税込)'] || '';
    const line = `[${cat}] ${name} ×${qty} ¥${amt}`;
    if (!byVisit.has(vr)) byVisit.set(vr, []);
    byVisit.get(vr).push(line);
  }
  const out = new Map();
  for (const [k, lines] of byVisit) out.set(k, lines.join('\n'));
  return out;
}

function buildVisitRow(r, treatmentMap) {
  const visit_record_no = toInt(r['来店記録番号']);
  const karte_no = toInt(r['カルテ番号']);
  return {
    visit_record_no,
    salon_name: r['サロン名'] || null,
    karte_no,
    customer_name: r['お客様名'] || null,
    main_staff: r['主担当'] || null,
    start_time: toTs(r['開始時刻']),
    end_time: toTs(r['終了時刻']),
    shimei_flag: toInt(r['指名フラグ']),
    memo: r['メモ'] || null,
    visit_number: toInt(r['訪問回数']),
    treatment_total: toInt(r['施術合計売上(税込)']),
    retail_total: toInt(r['店販合計売上(税込)']),
    tax_amount: toInt(r['税額']),
    tax_rounding: r['税端数処理'] || null,
    payment_status: r['会計状態'] || null,
    change_amount: toInt(r['お釣り']),
    cash: toInt(r['現金']),
    credit_card: toInt(r['クレジットカード']),
    points: toInt(r['ポイント']),
    other_payment: toInt(r['その他']),
    treatment_detail: treatmentMap.get(visit_record_no) || null,
    salon_id: SALON_ID,
  };
}

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定');
  return createClient(url, key, { auth: { persistSession: false } });
}

async function fetchExistingKarteSet(client, karteNos) {
  const set = new Set();
  for (let i = 0; i < karteNos.length; i += 1000) {
    const chunk = karteNos.slice(i, i + 1000);
    const { data, error } = await client.from('customers').select('karte_no').in('karte_no', chunk);
    if (error) throw error;
    for (const row of data) set.add(row.karte_no);
  }
  return set;
}

async function fixBrokenSegments(client) {
  const { data, error } = await client
    .from('customers')
    .select('karte_no, customer_segment')
    .not('customer_segment', 'is', null);
  if (error) throw error;
  const broken = data.filter(r => !VALID_SEGMENTS.includes(r.customer_segment));
  let fixed = 0;
  for (const row of broken) {
    const { error: uErr } = await client
      .from('customers')
      .update({ customer_segment: '新規失客' })
      .eq('karte_no', row.karte_no);
    if (uErr) {
      console.error(`  segment fix failed karte_no=${row.karte_no}: ${uErr.message}`);
    } else {
      console.log(`  segment fix karte_no=${row.karte_no}: "${row.customer_segment}" → "新規失客"`);
      fixed += 1;
    }
  }
  return { scanned: broken.length, fixed };
}

async function main() {
  console.log(`[import-visits] mode=${mode}`);

  const visitRows = readCsv(VISITS_CSV);
  const treatRows = readCsv(TREATMENTS_CSV);
  const treatmentMap = buildTreatmentDetailMap(treatRows);

  const records = [];
  const parseErrors = [];
  for (const r of visitRows) {
    const rec = buildVisitRow(r, treatmentMap);
    if (!rec.visit_record_no || !rec.karte_no) {
      parseErrors.push({ raw: r, reason: 'missing visit_record_no / karte_no' });
      continue;
    }
    records.push(rec);
  }

  const client = getClient();

  const karteNos = [...new Set(records.map(r => r.karte_no))];
  const existing = await fetchExistingKarteSet(client, karteNos);
  const writable = records.filter(r => existing.has(r.karte_no));
  const orphan = records.filter(r => !existing.has(r.karte_no));

  const { count: before } = await client.from('visits').select('*', { head: true, count: 'exact' });

  console.log(`  CSV visit rows:           ${visitRows.length}`);
  console.log(`  CSV treatment rows:       ${treatRows.length}`);
  console.log(`  parsed records:           ${records.length}`);
  console.log(`  parse errors:             ${parseErrors.length}`);
  console.log(`  karte_no in customers:    ${writable.length}`);
  console.log(`  karte_no orphan (skip):   ${orphan.length}`);
  console.log(`  with treatment_detail:    ${writable.filter(r => r.treatment_detail).length}`);
  console.log(`  visits in DB (before):    ${before}`);

  if (mode === 'dry-run') {
    console.log('[import-visits] DRY RUN — no writes');
    return;
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY が未設定 — RLS により書き込み不可');
  }

  let written = 0, failedBatches = 0;
  for (let i = 0; i < writable.length; i += BATCH_SIZE) {
    const batch = writable.slice(i, i + BATCH_SIZE);
    const { error } = await client.from('visits').upsert(batch, { onConflict: 'visit_record_no' });
    if (error) {
      failedBatches += 1;
      console.error(`  upsert batch ${i}-${i + batch.length} failed: ${error.message}`);
    } else {
      written += batch.length;
    }
  }
  console.log(`  upsert written:   ${written}`);
  console.log(`  upsert failed:    ${failedBatches} batch(es)`);

  console.log('[import-visits] fixing broken customer_segment ...');
  const segResult = await fixBrokenSegments(client);
  console.log(`  segment scanned: ${segResult.scanned}, fixed: ${segResult.fixed}`);

  const { count: after } = await client.from('visits').select('*', { head: true, count: 'exact' });
  console.log(`  visits in DB (after):  ${after}`);
}

main().catch(e => { console.error(e); process.exit(1); });
