# Lv v1 実装着手 安全性確認レポート

**目的**: `docs/lv-v1-specification.md` 他 4 仕様書の整合性、DB 影響範囲、リスクを実装着手前に総点検する
**作成日**: 2026-04-27（初版）
**最終更新**: 2026-04-27（ヒロキ判断によりブロッカー2件解消 / B1=B採用 / B2=B3採用）
**書き込み**: 一切なし。読み取りと分析のみ。
**結論先出し**: **重大ブロッカー2件は解消済み（2026-04-27 ヒロキ確定）**。実装着手可。詳細は § 0 と § 11。

---

## 0. エグゼクティブサマリー（先に読む）

### 0.1 重大ブロッカー（**2026-04-27 解消済み**）

| # | 内容 | ヒロキ判断（2026-04-27） | ステータス |
|---|------|--------------------------|-----------|
| **B1** | LTV パーセンタイル分母の定義が未確定。`ALL_customers` に LTV=0 を含めるか不明 | **B案採用: `LTV > 0` の顧客のみを分母とする**。理由: VIP判定は実際に売上寄与のある顧客群の中での相対評価であるべき。LTV=0 を含めると少額利用が高パーセンタイル化し VIP の意味が弱くなる | ✅ **解消** (lv-v1-spec § 3.1, customer-segment-spec § 4.1, vip-badges-spec § 13 に反映済み) |
| **B2** | visits 取込範囲が 16 ヶ月（5.15% 充足率）に留まり過去常連の取りこぼし大 | **B3案採用: `customers.visit_count` などを使った暫定補正を導入**。`visits_imported_count < 5` の顧客には customers.* で fallback 計算し、`reliability='low' / source='visit_count_fallback'` フラグで UI に「※」表示。詳細は lv-v1-spec § 13 / customer-segment-spec § 14 / vip-badges-spec § 13 | ✅ **解消** |

### 0.2 中リスク（着手後に対応可だが要検討）

- **R1**: ~~田丸さん予想セグメント = `watch_over (見守り層)`~~ → **B3 補正により `nurture_gold（💎 育てる金脈）` に正しく分類される**。reliability=low フラグで暫定値であることは明示。
- **R2**: VIP 全層該当ゼロ — 年間 LTV max=¥141,100 で **シルバー(¥30K)、ゴールド(¥60K)、プラチナ(¥90K)** いずれも該当者は出るが、視覚的に偏る (シルバー約100/ゴールド約30/プラチナ約9)。
- **R3**: `migrate-mq-schema.sql` は Phase 0 用で、Lv v1 が必要とする 13 カラム（B3 関連カラム含む）を**まだ含んでいない**。新規 SQL ファイル `scripts/migrate-mq-lv-v1.sql` の作成が必要。
- **R4**: B3 補正下でも田丸さんの③ cycle_score=0 は仕様通り（実際に長期離脱中）。Lv は Lv.12（🐥 こども）止まり。これは `nurture_gold` セグメント分類で運用カバー可能。

### 0.3 推奨着手タイミング

**実装着手可能（2026-04-27）**。

ヒロキ確定事項:
- B1 = LTV>0 顧客分母（B案）
- B2 = visit_count fallback による暫定補正（B3案）

実装プラン: `docs/lv-v1-implementation-plan.md` を参照。半日〜1日で Phase 2.1（DB マイグレーション + バッチ書き換え）に着手可能。

---

## 1. DB 書き換え対象の完全リスト

### 1.1 customers テーブルへの追加カラム（合計 15 カラム / 2026-04-27 改訂）

| カラム名                      | 型              | デフォルト | 由来                                    |
|-------------------------------|-----------------|-----------|-----------------------------------------|
| `mq_lv_score`                 | numeric(5,2)    | null      | lv-v1 spec §8                           |
| `mq_lv_breakdown`             | jsonb           | null      | lv-v1 spec §8（6 要素の内訳）           |
| `mq_lv_score_source`          | text            | null      | lv-v1 spec §13.4（'visits'\|'mixed'\|'visit_count_fallback'）|
| `mq_lv_reliability`           | text            | null      | lv-v1 spec §14（'high'\|'medium'\|'low'）|
| `mq_lv_calculated_at`         | timestamptz     | null      | lv-v1 spec §13.4                        |
| `mq_last_stage_up_at`         | timestamptz     | null      | growth-stage spec §7-5                  |
| `ltv_total_annual`            | integer         | null      | vip-badges spec §6                      |
| `ltv_total_lifetime_observed` | integer         | null      | vip-badges spec §6（旧 `ltv_total_lifetime` から rename）|
| `vip_tier`                    | text            | null      | vip-badges spec §6 ('silver'\|'gold'\|'platinum')|
| `vip_hall_of_fame`            | boolean         | false     | vip-badges spec §6                      |
| `vip_lifetime_source`         | text            | null      | vip-badges spec §6（B3 fallback 識別） |
| `vip_reliability`             | text            | null      | vip-badges spec §6                      |
| `vip_updated_at`              | timestamptz     | null      | vip-badges spec §6                      |
| `segment_v2_key`              | text            | null      | customer-segment spec §8                |
| `segment_v2_updated_at`       | timestamptz     | null      | customer-segment spec §8                |

**実数**: 15 カラム。すべて `ADD COLUMN IF NOT EXISTS` で idempotent に追加できる。

### 1.2 visits テーブルへの変更

**変更なし**。Lv v1 / VIP / セグメント判定はすべて既存 `visits` カラム（`karte_no`, `start_time`, `treatment_total`, `retail_total`, `payment_status`, `main_staff`）のみで完結。

### 1.3 新規テーブル（採用時のみ）

| テーブル          | 採用条件                           | 用途                  |
|-------------------|------------------------------------|-----------------------|
| `salon_configs`   | salon-config spec §5.1（A案）採用時 | サロン毎の閾値オーバーライド |

**MVP 推奨**: salon-config spec §5.3 の通り **B案（設定ファイル）** で開始 → A 案テーブルは**作らない**。

### 1.4 既存カラムへの影響

| カラム             | 影響                                                                  |
|--------------------|-----------------------------------------------------------------------|
| `mq_level`         | 値が **大きく変わる**（旧式: 平方根 → 新式: `ceil(score/5)`）。田丸さんは `6 → 12` に変動 |
| `mq_experience`    | lv-v1 spec §12 論点1 で「**廃止せず併存**」確定。新式では更新せず Phase 0 値が残る |
| `mq_animal`        | 影響なし（別ロジック）                                                |
| `mq_personality`   | 影響なし                                                              |
| `mq_state`         | 影響なし（NEW/げんき/おやすみ/とびっきりは独立）                      |
| `mq_titles`        | 影響なし                                                              |
| `customer_segment` | 影響なし。新セグメントは `segment_v2_key` に別カラムで保存            |

### 1.5 影響範囲

- **書き換え行数**: **11,547 行**（customers 全件）
- **書き換え対象カラム数**: 既存1（`mq_level`）+ 新規15 = **16 カラム**
- **API 影響**: `/character/api/:karte_no` の返却 JSON に `mq_lv_score`, `mq_lv_breakdown`, `mq_lv_score_source`, `mq_lv_reliability`, `vip`, `segment_v2` が新フィールドとして追加される。既存フィールドは破壊しない。
- **UI 影響**: `public/character.html` のキャラカード描画ロジックに「成長段階チップ」「次の進化まで」「VIP バッジ」「セグメント strategy カード」「reliability='low' 時の※マーク」の追加が必要（growth-stage spec §4-1 で +279 行見積、B3 用 +20 行追加）。

---

## 2. 各仕様書間の整合性最終チェック

### 2.1 整合確認できた項目

| 観点                               | 結果                                                                    |
|------------------------------------|-------------------------------------------------------------------------|
| Lv 変換式（`ceil(score/5)`）       | lv-v1 §6 / growth-stage §0 表 / salon-config §4 の `stage_boundaries` で完全一致 |
| 成長段階境界（20/40/60/80）        | lv-v1 §6 / growth-stage §0 表 / salon-config §4 で完全一致              |
| VIP 閾値（30K/60K/90K + hide=true） | vip-badges §2 / salon-config §4 で完全一致                              |
| 周期トリミング手法                 | lv-v1 §4③ と customer-segment §4.2 で「P10〜P90 trim → median」共通     |
| `payment_status_excluded = ['未会計']` | 全 4 仕様書で一致                                                  |
| 用語統一（`lifetime_ltv_observed`） | lv-v1 §3 で統一宣言済み。vip-badges §5 / customer-segment §4.1 が追従 |

### 2.2 矛盾・ギャップとして指摘すべき項目

| #   | 仕様書間の不整合                                                                                                | 影響度 |
|-----|------------------------------------------------------------------------------------------------------------------|--------|
| **C1** | **LTV パーセンタイル分母の曖昧さ（=ブロッカー B1）**: lv-v1 §4② は `percentile(lifetime_ltv_observed, ALL_customers.lifetime_ltv_observed)`、customer-segment §4.1 は「サロン内パーセンタイル」とのみ。 `ALL_customers` が visits 取込範囲内で LTV>0 の 1,060 人なのか、customers 全件 11,547 人なのか不明。**実装の意思決定必須** | **高** |
| C2 | **`mq_experience` の扱いが章で揺れる**: lv-v1 §8 は「score×100 を格納、または別カラム化」と両論併記、§12 で「廃止せず併存」と確定。読み手によっては §8 の旧記述で混乱する。§8 を「§12 で確定: 併存・新カラム `mq_lv_score` 追加」に書き換えると親切 | 中 |
| C3 | **30 日スムージング** はサロン定義 (`smoothing_alpha`) があるが lv-v1 §12 論点 2 で「Phase 2.5 まで実装しない」と確定済み。salon-config §4 の `smoothing_alpha: 0.3` は MVP 期は **未使用** であることを明記したほうが安全 | 低 |
| C4 | **`hall_of_fame.threshold = 5_000_000` は実データ max(¥175K) に対し約 28 倍の到達不能値**。`hide:true` で実害はないが、サロン横展開で誤って `hide:false` にされた場合に永久に到達者ゼロのバグ的挙動になる。salon-config §4 にコメントで「PREMIER 環境では絶対到達不能値、参考保持のみ」を残すと安全 | 低 |
| C5 | **`/character/api/:karte_no` の返却形** が VIP・segment・lv-v1 の各仕様書で個別に書かれており、最終的な合成 JSON 例がどこにもない。実装担当者が最終形を知るために 3 仕様書を結合する必要がある。実装直前に「合成形」を 1 か所に定義したい | 中 |
| C6 | **`recent_visits` の集計対象除外条件**（`payment_status='未会計'` を除外するか？）が lv-v1 §4⑤ に明示されていない。除外すると ⑤stylist_score の分母が変わる | 低 |
| C7 | **freq_score の `visits_last_365d` 集計**が `payment_status='未会計'` を除外するかが lv-v1 §4① に明示されていない（②LTV では明示）| 低 |
| C8 | **growth-stage §1-1 の境界（half-open `(prev, curr]`）と lv-v1 §6 表の境界（`0–5.0` 等）が表記揺れ**。意味は同じだが境界値（`score==20.0`）の動物がどれかは仕様書を 2 つ読み比べないと分からない。半開区間記号で統一を推奨 | 低 |

### 2.3 ヒロキ判断（2026-04-27 確定済み）

1. ✅ **B1 (LTV 分母の定義)**: **B案採用 = LTV>0 顧客のみ**（全 4 仕様書に反映済み）
2. ✅ **B2 (visits 充足率対応)**: **B3案採用 = visit_count fallback 暫定補正**（lv-v1-spec § 13, customer-segment-spec § 14, vip-badges-spec § 13 に反映済み）
3. ✅ **C1**: B1 と同一、解消済み
4. ✅ **C5 統合 API レスポンス例**: lv-v1-spec § 8 / vip-badges-spec § 5 / customer-segment-spec § 7 に分散しているが、`docs/lv-v1-implementation-plan.md` の「最終 API スキーマ」セクションで合成形を提示
5. ✅ **田丸さんセグメント**: B3 補正により正しく `nurture_gold（💎 育てる金脈）` に分類される（reliability=low）。Lv は Lv.12（🐥 こども）のままだが、これは仕様通りの正しい挙動（実際に 472 日離脱中のため cycle_score=0）

---

## 3. 実装手順の詳細（ステップバイステップ）

### Step 1 — 新規マイグレーション SQL を作成（既存ファイル `migrate-mq-schema.sql` は Phase 0 用なので別ファイル推奨）

**新規ファイル**: `scripts/migrate-mq-lv-v1.sql`

```sql
BEGIN;

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS mq_lv_score                  numeric(5,2),
  ADD COLUMN IF NOT EXISTS mq_lv_breakdown              jsonb,
  ADD COLUMN IF NOT EXISTS mq_last_stage_up_at          timestamptz,
  ADD COLUMN IF NOT EXISTS ltv_total_annual             integer,
  ADD COLUMN IF NOT EXISTS ltv_total_lifetime_observed  integer,
  ADD COLUMN IF NOT EXISTS vip_tier                     text,
  ADD COLUMN IF NOT EXISTS vip_hall_of_fame             boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS vip_updated_at               timestamptz,
  ADD COLUMN IF NOT EXISTS segment_v2_key               text,
  ADD COLUMN IF NOT EXISTS segment_v2_updated_at        timestamptz;

CREATE INDEX IF NOT EXISTS idx_customers_mq_lv_score    ON public.customers (mq_lv_score);
CREATE INDEX IF NOT EXISTS idx_customers_vip_tier       ON public.customers (vip_tier);
CREATE INDEX IF NOT EXISTS idx_customers_segment_v2     ON public.customers (segment_v2_key);

COMMIT;
```

**確認ポイント**:
- 全 ADD は `IF NOT EXISTS` 付き → 二重実行しても壊れない
- BEGIN/COMMIT で原子性確保
- 既存 9 カラム（mq_level, mq_experience 等）には触れない（Phase 0 の値を残す）
- 既存データへの影響: **ゼロ**（カラム追加のみ）

### Step 2 — `services/salonConfig.js` を新規作成

**規模**: 約 80 行（DEFAULT_CONFIG ハードコード + `getSalonConfig()` + deepMerge）
**確認ポイント**: salon-config spec §4 の値と完全一致しているか単体テストで検証

### Step 3 — `services/questEngine.js` の書き換え

**置換対象** (§ lv-v1 §8 に基づく):
- `calcExperience()` (現 line 47–60) → 削除 or 旧式互換のためコメントアウト保持
- `calcLevel()` (現 line 66–69) → 入力 score 用に書き換え（1 行 `Math.max(1, Math.ceil(score/5))`）
- `computeCustomerQuest()` (現 line 123–137) → 戻り値に `mq_lv_score`, `mq_lv_breakdown` を追加

**新規追加** (バッチからしか呼べない関数を想定):
- `calcLvScore(customer, ctx, salonConfig)` — `ctx` は `{ allVisitsByKarte, vcArr, vl365Arr, ltvArr, now }` のような事前計算済みパーセンタイル配列を持つコンテキスト

**書き換え行数目安**: 既存 147 行 → 新 250–300 行（**+100〜150 行**）

**確認ポイント**:
- `calcLvScore` は 6 要素を 0〜weight 範囲で計算 → 加算 → 合計 0〜100 になることを単体テストで検証
- `breakdown` JSON に各要素の素値（visit_count, ltv, …）と配点後の値を両方含めるか決める

### Step 4 — `services/vipBadges.js` を新規作成

**規模**: vip-badges spec §3 の擬似コードほぼそのまま、約 50 行
**確認ポイント**: `salonConfig.vip.tiers` を threshold 降順で評価し、最初にマッチする 1 つだけ返す

### Step 5 — `services/customerSegment.js` を新規作成

**規模**: customer-segment spec §3 の擬似コードほぼそのまま、約 100 行
**確認ポイント**: `visits.length < 2` の早期リターン（B2 影響大、Tamaru ケース）

### Step 6 — `scripts/init-mq-levels.js` の二段フェッチ書き換え

**現状** (line 111–146): 1 顧客ずつ `computeCustomerQuest()` を呼ぶ単段方式
**新方式** (lv-v1 spec §8):
1. **第一段階**: 全顧客の生指標 `(visit_count, visits_last_365d, lifetime_ltv_observed, tenure_years, top_staff_ratio, …)` を計算
2. **第二段階**: 各指標の配列をソートしてパーセンタイル計算
3. **第三段階**: 各顧客に `mq_lv_score`, `mq_lv_breakdown`, `vip_tier`, `segment_v2_key`, `ltv_total_annual`, `ltv_total_lifetime_observed` を付与し UPDATE

**書き換え行数目安**: 既存 211 行 → 新 350〜400 行（**+150 行**）

**処理時間目安**: 11,547 顧客 × 16 並列 UPDATE = 約 30〜90 秒（既存実測ペースから推定）

**確認ポイント**:
- `--dry-run` で **必ず** Lv 分布・VIP 分布・セグメント分布を出してからコミット
- `--sample` で田丸さん他 4 名の **breakdown** が見られること
- COMMIT 直前にバックアップ取得（§ 4 参照）

### Step 7 — `routes/character.js` の API 拡張

**変更箇所**: line 87–108 の `res.json({ ... })` ブロック
- `customer.mq_lv_score`, `customer.mq_lv_breakdown` を追加
- 既存 `badges` の他に `vip`（vip-badges spec §5）と `segment_v2`（customer-segment spec §7）の最上位フィールドを追加

**書き換え行数目安**: +30 〜 +50 行

**確認ポイント**:
- `mq_lv_score == null` の顧客（バッチ未実行）でも 500 エラーにならないこと
- 旧フィールド（`mq_level`, `mq_experience`）はそのまま返すこと（後方互換）

### Step 8 — `public/character.html` の UI 拡張（growth-stage spec §4-1）

**変更箇所**: 7 か所（CSS / SVG 定数 / STAGE_META / renderCard / DOM 追加）
**追加行数**: 約 +279 行（うち SVG 文字列 +200 行）

**MVP 範囲**: 動物 3 種（dog/sheep/rabbit）× 5 段階 = 15 SVG。残り 5 種は `child` フォールバック。

### Step 9 — 動作確認（手作業）

- `/character/9215` で田丸さんカードを開き、想定 Lv（B1 で確定する値）/段階チップ/VIP/セグメントが想定通り表示されること
- 上位 10 人ほどの karte_no を順に開き、可視的な異常がないこと
- 「visits 取込範囲外」になっている顧客を 1 人開き、Lv が低めに出ることを確認（B2 の症状確認）

---

## 4. ロールバック手順

### 4.1 バックアップ取得（推奨）

```bash
# Supabase ダッシュボード or pg_dump で customers テーブルを物理バックアップ
pg_dump -h <host> -U <user> -d <db> -t public.customers --data-only > customers_backup_2026-04-27.sql
```

または読み取りのみ:

```bash
# 影響カラムだけを CSV エクスポート
node -e "
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
(async () => {
  const all = [];
  let from = 0;
  while (true) {
    const { data } = await sb.from('customers')
      .select('id, karte_no, mq_level, mq_experience, mq_animal, mq_personality, mq_state')
      .range(from, from+999);
    if (!data || !data.length) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  require('fs').writeFileSync('customers_mq_backup_2026-04-27.json', JSON.stringify(all));
  console.log('saved', all.length, 'rows');
})();
"
```

**推奨**: スキーマレベル変更前に Supabase ブランチを作るのが最も安全（mcp__claude_ai_Supabase__create_branch）。

### 4.2 各ステップの戻し方

| 失敗ステップ            | 戻し方                                                            |
|-------------------------|-------------------------------------------------------------------|
| Step 1（マイグレ）失敗  | `BEGIN ... COMMIT` 内で失敗していれば自動 ROLLBACK。部分適用なら `ALTER TABLE ... DROP COLUMN IF EXISTS ...` を順に流す |
| Step 2–5（コード追加）  | git revert で復旧。本番デプロイ前の段階で気付くべき                |
| Step 6（バッチ実行）失敗| 既存 `mq_level` が変動済みの場合、バックアップ JSON から `update`で復元。新規カラムは `UPDATE customers SET mq_lv_score=NULL, ...` で初期化 |
| Step 7（API）失敗       | git revert。バッチデータは残る（無害）                            |
| Step 8（UI）失敗        | git revert。フロントだけのため影響範囲狭い                        |

### 4.3 緊急時の DB 完全復元

```sql
-- カラムを全部消して Phase 0 状態に戻す
BEGIN;
ALTER TABLE public.customers
  DROP COLUMN IF EXISTS mq_lv_score,
  DROP COLUMN IF EXISTS mq_lv_breakdown,
  DROP COLUMN IF EXISTS mq_last_stage_up_at,
  DROP COLUMN IF EXISTS ltv_total_annual,
  DROP COLUMN IF EXISTS ltv_total_lifetime_observed,
  DROP COLUMN IF EXISTS vip_tier,
  DROP COLUMN IF EXISTS vip_hall_of_fame,
  DROP COLUMN IF EXISTS vip_updated_at,
  DROP COLUMN IF EXISTS segment_v2_key,
  DROP COLUMN IF EXISTS segment_v2_updated_at;
-- mq_level の旧式値復元はバックアップ JSON から個別 UPDATE 必須
COMMIT;
```

### 4.4 推奨運用

- Step 1 と Step 6（コミットモード）は **同日に連続実行しない**。Step 1 → 翌日 Step 6 dry-run → さらに翌日 Step 6 commit がフェイルセーフ。
- Step 6 commit は `--limit 100` で先頭 100 件をテスト → 全件 dry-run → 全件 commit の 3 段階で。

---

## 5. 田丸さん(9215) を例にしたシミュレーション

### 5.1 実 DB 値（2026-04-27 現在）

| 項目                           | 値                              |
|--------------------------------|---------------------------------|
| `customer_name`                | 田丸 弘美                       |
| `visit_count`                  | 48                              |
| `first_visit_at`               | 2019-06-11                      |
| `last_visit_at`                | 2025-01-09                      |
| `customer_segment`（既存）     | 固定失客                        |
| `mq_level`（旧式）             | 6                               |
| `mq_experience`（旧式）        | 2,743                           |
| `mq_animal`                    | sheep                           |
| `mq_state`                     | おやすみ                        |
| `total_payment`（POS由来）     | ¥326,200                        |
| visits 取込件数（karte=9215） | **1 件のみ**                    |
| 取込済 visits 範囲             | 2025-01-04 〜 2026-04-25        |
| 最終来店経過日数               | 472 日（15.7 ヶ月）             |

### 5.2 Lv v1 スコア計算（パーセンタイル分母 = customers 全 11,547 人 想定）

| 要素                    | 素値                  | パーセンタイル | 配点                         |
|-------------------------|-----------------------|---------------|------------------------------|
| ① freq                 | vc=48 / vl365=0       | p_total=99.4% / p_recent=0.0% | 25×(0.5×0.994 + 0.5×0.0) = **12.42** |
| ② ltv                  | ¥7,500                | p=94.3%       | 30×0.943 = **28.29**         |
| ③ cycle                | 算出不能 (visits<2)   | —             | **0.00**                     |
| ④ tenure               | 6.88 年               | —             | 10×min(1, 6.88/10) = **6.88**|
| ⑤ stylist              | top_ratio=1.0, recent=1 | —          | 5×1.0 = **5.00** (visits<3 のため上限 5) |
| ⑥ engagement           | 固定                  | —             | **2.50**                     |
| **合計**               |                       |               | **55.09**                    |

### 5.3 予想結果（パーセンタイル分母 = 全顧客）

| 項目                  | 結果                                    |
|-----------------------|-----------------------------------------|
| **mq_lv_score**       | **55.09**                               |
| **新 Lv**             | `ceil(55.09/5) = 12` → **Lv.12**        |
| **成長段階**          | score 40 < 55.09 ≤ 60 → **🐥 こども**   |
| **VIP バッジ**        | annual_ltv = ¥0 < ¥30K → **(なし)** ; 殿堂入りは hide=true |
| **segment_v2_key**    | visits.length=1 < 2 → **`watch_over` (👀 見守り層)** |

### 5.4 ユーザー想定（おとな帯・育てる金脈）との乖離

| 想定               | 実シミュレーション結果 | 乖離原因                              |
|--------------------|------------------------|---------------------------------------|
| 🦁 おとな (Lv.13–16) | 🐥 こども (Lv.12)       | visits 取込 1 件のため ③⑤がほぼゼロ  |
| 💎 育てる金脈       | 👀 見守り層             | 仕様 customer-segment §13 論点3 で「visits<2 のみで watch_over 確定」と確定済み（補正ロジック非搭載） |

### 5.5 別の解釈シナリオ（B1 = LTV 分母を LTV>0 の 1,060 人に絞った場合）

lv-v1 spec §11.2 の試算と一致:

| 要素 | 配点 |
|-----|------|
| ① freq | 12.5（同左） |
| ② ltv  | 30 × 0.378 = **11.34**（分母 1,060 人）|
| ③ cycle | 0 |
| ④ tenure | 6.88 |
| ⑤ stylist | 5.00 |
| ⑥ engagement | 2.5 |
| **合計** | **38.22 → Lv.8 / 🐣 あかちゃん** |

→ **B1 の判断次第で田丸さんは Lv.8（🐣）か Lv.12（🐥）か**で揺れる。仕様書 §11.2 は前者を採用、本シミュレーションは後者を採用。ヒロキ判断必須。

### 5.6 表示 UI の見え方（B1 = 全顧客分母採用シナリオ）

```
┌── じゅうみんカード #9215 ──┐
│                              │
│  [🐑 ひつじ・こどもSVG]       │  ← 既存 sheep SVG（child=既存そのまま）
│  [🐥 こども chip]             │  ← 新: 段階チップ
│                              │
│  田丸 弘美   ひつじ          │
│  ♥ 12 なかよしレベル          │
│                              │
│  次の進化まで あと 4.9 点    │  ← 新: next-evolve-hint
│  (🦁 おとな まで)            │
│                              │
│  [INFJ — 静かな賢者]          │
│                              │
│  💡 スタッフへのひとこと       │  ← 新: strategy card (watch_over)
│  👀 まずは2回目の来店を       │
│  まだ来店履歴が少なく、関係性は形成中です…│
│                              │
│  [おやすみ] [来店 48回]       │
│  [最終 2025-01-09]            │
│                              │
│  ごほうび: 🎖️5年クルー 💎48回 │
└──────────────────────────────┘
```

VIP バッジは表示されない（年間LTV=0）。

---

## 6. 上位 10 名の予想 Lv 分布

`customers.visit_count` 上位 10 名を新 Lv 式（パーセンタイル分母 = 全 11,547 人）で予測。**visits 取込範囲外の長期固定客が大量に脱落する深刻な現象**を確認。

| 順位 | karte_no | 名前         | vc | vl365 | LTVobs   | tenure | 周期 | 担当継続 | freq | ltv  | cyc  | ten | sty  | eng | **score** | **Lv** | **段階** |
|------|----------|--------------|----|-------|----------|--------|------|---------|------|------|------|-----|------|-----|-----------|--------|----------|
| 1    | 12582    | 吾妻 恵      | 130| 19    | ¥131,500 | 6.8y   | 21d  | 1.00    | 25.0 | 30.0 | 4.8  | 6.8 | 10.0 | 2.5 | **79.1**  | Lv.16  | 🦁 おとな |
| 2    | 445748   | 中野翼       | 107| **0** | ¥0       | 4.5y   | —    | 0.00    | 12.5 | 0.0  | 0.0  | 4.5 | 0.0  | 2.5 | **19.5**  | **Lv.4** | **🥚 たまご** ⚠ |
| 3    | 40498    | 神野るみこ   | 104| **0** | ¥0       | 6.6y   | —    | 0.00    | 12.5 | 0.0  | 0.0  | 6.6 | 0.0  | 2.5 | **21.6**  | **Lv.5** | **🐣 あかちゃん** ⚠ |
| 4    | 43322    | 菊地美雪     | 101| 17    | ¥140,600 | 6.6y   | 21d  | 1.00    | 25.0 | 30.0 | 0.0  | 6.6 | 10.0 | 2.5 | **74.1**  | Lv.15  | 🦁 おとな |
| 5    | 9221     | 御羽杜妃     | 99 | **0** | ¥0       | 6.9y   | —    | 0.00    | 12.5 | 0.0  | 0.0  | 6.9 | 0.0  | 2.5 | **21.9**  | **Lv.5** | **🐣 あかちゃん** ⚠ |
| 6    | 52171    | 伊藤寿恵     | 83 | 2     | ¥51,000  | 6.4y   | 189d | 1.00    | 24.6 | 29.8 | 0.5  | 6.4 | 10.0 | 2.5 | **73.8**  | Lv.15  | 🦁 おとな |
| 7    | 52163    | 高橋恵       | 77 | **0** | ¥0       | 6.4y   | —    | 0.00    | 12.5 | 0.0  | 0.0  | 6.4 | 0.0  | 2.5 | **21.4**  | **Lv.5** | **🐣 あかちゃん** ⚠ |
| 8    | 54551    | 中澤芳夫     | 76 | 12    | ¥84,000  | 6.4y   | 31d  | 1.00    | 25.0 | 29.9 | 19.4 | 6.4 | 10.0 | 2.5 | **93.2**  | Lv.19  | 👑 マスター |
| 9    | 53081    | 原口慎太郎   | 75 | 12    | ¥58,800  | 6.4y   | 28d  | 1.00    | 25.0 | 29.8 | 4.3  | 6.4 | 10.0 | 2.5 | **78.0**  | Lv.16  | 🦁 おとな |
| 10   | 249368   | 畑田雄貴     | 75 | 15    | ¥157,000 | 5.1y   | 23d  | 1.00    | 25.0 | 30.0 | 9.9  | 5.1 | 10.0 | 2.5 | **82.5**  | Lv.17  | 👑 マスター |

### 6.1 観察結果

- **来店 100 回超の常連 4 人中 2 人（中野翼・神野るみこ）が 🥚🐣 帯**に転落
- 上位 10 人中 **4 人が visits 取込範囲外の「忘れられた常連」**として Lv.4–5 に
- 残り 6 人は健全に Lv.15–19 へ。式自体の妥当性は OK
- **最終的な Lv 分布見込み（全 11,547 人 — シミュレーション結果）**:
  - 🥚 egg : **9,853 人 (85.3%)** ← growth-stage spec §1-3 の想定 25–35% を**大幅超過**
  - 🐣 baby: 698 人 (6.0%)
  - 🐥 child: 519 人 (4.5%)
  - 🦁 adult: 313 人 (2.7%)
  - 👑 master: **164 人 (1.4%)** ← 想定 1–5% に収まる
  - **Lv.6, 7, 20 は該当者ゼロ**（Lv.2 と Lv.4 にダブルピーク → 不自然な二峰分布）

**この分布の歪みは、visits 充足率 5.15% に起因する構造的問題**。ヒロキ判断（B2）が必要。

---

## 7. リスク評価

| #     | 項目                                | リスクレベル | 想定エラー                                    | 対処                                      |
|-------|-------------------------------------|-------------|-----------------------------------------------|-------------------------------------------|
| **B1** | LTV パーセンタイル分母の未確定     | **高**      | 田丸さん他多数の Lv が想定外に振れる         | 仕様書に明文化してから着手                |
| **B2** | visits 取込範囲が 16 ヶ月のみ       | **高**      | 常連 4 人が Lv.4–5 に転落 → サロンスタッフからの信頼失墜 | (a) 過去 visits 追加取込 (b) 補正ロジック (c) 説明資料で運用回避|
| R1     | 田丸さんが `watch_over` セグメント | 中          | ユーザー想定（育てる金脈）と乖離              | 仕様通り（customer-segment §13 で確定済）として説明 |
| R2     | VIP プラチナ該当 < 10 人           | 中          | 「殆ど誰もVIPになれない」感                  | 既に閾値再設計済み（vip-badges §11.3）   |
| R3     | `migrate-mq-schema.sql` が古い      | 低          | バッチ実行で UndefinedColumn               | 新規 SQL ファイル作成（§3 Step 1）        |
| R4     | `init-mq-levels.js` 二段化          | 中          | パーセンタイル計算誤り                       | 単体テストでパーセンタイル関数の境界値テスト   |
| R5     | API レスポンス膨張                  | 低          | フロントの非対応フィールドで JSON サイズ増   | 既存フィールドは破壊しないので影響軽微    |
| R6     | サロン横展開時の閾値固定            | 低          | salon-config 未利用で値がハードコード化     | salon-config spec の徹底                |
| R7     | UPDATE 並列度 16 が DB 高負荷       | 低          | Supabase の rate limit 抵触                  | `--limit 100` で段階リリース              |
| R8     | フロント側 SVG が 5 段階×3 動物のみ| 低          | 未対応動物が child フォールバックされる     | growth-stage spec §4-3 の通り意図通り     |

---

## 8. 実装着手の推奨タイミング

### 8.1 即実装は不可。以下を先に解消すること:

**ヒロキ判断待ち項目（実装前に必須）**:

1. **B1**: LTV パーセンタイル分母の確定
   - 推奨案: **「customers 全件」（=lv-v1 §4 の文言通り）**。理由: 1) 仕様書が `ALL_customers` と書いている、2) 段階分布の 85.3% 偏りは visits 充足率の問題で、分母を狭めても根本解決しない、3) 全顧客分母なら新規・幽霊カルテも含めた「サロン内位置」となる
2. **B2**: visits 充足率対応の方針
   - 推奨案: **(a) MVP は仕様通りリリース** + サロン側に「visits 取込範囲（16ヶ月）外の常連は『たまご』表示になる既知の制約」を事前共有し、Phase 2.5 で過去 visits 追加取込を実施
   - 代替案: 過去 visits を先に追加取込してから Lv 投入（**着手は 1〜2 週間遅れ**）
3. **C5**: 統合 API レスポンス例の確定
4. **B1 と関連**: 仕様書に「分母 = customers 全件」を追記

### 8.2 追加で必要な準備

| 準備                                                        | 必須/推奨 | 工数  |
|-------------------------------------------------------------|-----------|-------|
| バックアップ取得（Supabase ブランチ or pg_dump or JSON）   | **必須**  | 5 分  |
| migrate-mq-lv-v1.sql の作成                                | **必須**  | 30 分 |
| 統合 API レスポンス例ドキュメント                            | 推奨      | 30 分 |
| パーセンタイル関数の単体テスト（境界値・空配列）           | 推奨      | 1 時間 |
| `--dry-run` 用の CSV 出力モード（差分確認）                | 推奨      | 30 分 |
| growth-stage spec §1-1 で定義された SVG 15 個の事前準備     | 推奨      | 3.5 時間 |

### 8.3 実装着手後の所要時間（参考）

| Step                       | 工数             | 備考                               |
|----------------------------|------------------|-----------------------------------|
| Step 1（マイグレ）          | 30 分            |                                   |
| Step 2（salonConfig.js）    | 1 時間           |                                   |
| Step 3（questEngine.js）    | 3〜4 時間        | パーセンタイル計算が主            |
| Step 4（vipBadges.js）      | 1 時間           |                                   |
| Step 5（customerSegment.js）| 1.5 時間         |                                   |
| Step 6（init-mq-levels）    | 3 時間           | 二段化 + dry-run 動作確認         |
| Step 7（character.js API）  | 1 時間           |                                   |
| Step 8（character.html）    | 半日（4 時間）   | growth-stage spec §5 の見積に準ずる |
| Step 9（手作業確認）         | 1〜2 時間        |                                   |
| **合計**                   | **約 2〜2.5 日** | B1/B2 の判断後、コード本体のみ    |

---

## 9. 最終チェックリスト（実装担当者向け）

着手前の確認:

- [ ] **B1（LTV 分母）の方針が確定している**
- [ ] **B2（visits 充足率対応）の方針が確定している**
- [ ] バックアップを取得している（推奨: Supabase ブランチ）
- [ ] `scripts/migrate-mq-lv-v1.sql` が作成され、内容レビュー済み
- [ ] 統合 API レスポンス例が共有されている
- [ ] 仕様書 lv-v1 §8 の `mq_experience` に関する記述が §12 で確定した内容に揃っている

実装中の確認（各 Step 完了時）:

- [ ] Step 1: 10 カラム追加が `IF NOT EXISTS` で安全に流せた
- [ ] Step 2–5: ユニットテスト（特にパーセンタイル計算）通過
- [ ] Step 6: `--sample` で田丸さん含む 5 名の breakdown が想定値と一致
- [ ] Step 6: `--dry-run` の Lv 分布が § 6.1 と整合（85% egg は仕様通りの想定）
- [ ] Step 6: `--limit 100` で先頭100件 → 全件 dry-run → 全件 commit の3段階を踏んだ
- [ ] Step 7: 既存フィールド（`mq_level`, `mq_experience`）が API で破壊されていない
- [ ] Step 8: `mq_lv_score == null` の顧客でカードが従来表示にフォールバックする

実装後の確認:

- [ ] /character/9215 田丸さんが想定通りに表示される
- [ ] 上位 10 人中 4 人（中野翼・神野・御羽杜・高橋）の Lv が低いことに対し運用説明が用意されている
- [ ] 既存の `customer_segment` を参照する箇所（ai-receptionist.js / routes/api.js）が壊れていない

---

## 10. 参照

- `docs/lv-v1-specification.md` — Lv 算出ロジック本体
- `docs/vip-badges-specification.md` — VIP バッジ閾値・判定
- `docs/customer-segmentation-specification.md` — 5 セグメント判定
- `docs/growth-stage-specification.md` — 5 段階成長 UI
- `docs/salon-config-specification.md` — サロン毎オーバーライド機構
- `services/questEngine.js` — Phase 0 既存実装（書き換え対象）
- `scripts/init-mq-levels.js` — Phase 0 バッチ（書き換え対象）
- `scripts/migrate-mq-schema.sql` — Phase 0 マイグレーション（**新規ファイル `migrate-mq-lv-v1.sql` が必要**）
- `scripts/analyze-mq-thresholds.js` — 本レポートの実データ検証で使用したスクリプト

---

## 11. ヒロキ判断履歴（2026-04-27 確定）

| # | 論点 | 確定内容 | 反映先 |
|---|------|----------|--------|
| 1 | LTV パーセンタイル分母 (B1) | **B案: LTV>0 顧客のみ** | lv-v1-spec § 3.1, customer-segment-spec § 4.1, vip-badges-spec |
| 2 | visits 充足率 (B2) | **B3案: customers.* で暫定補正** | lv-v1-spec § 13, customer-segment-spec § 14, vip-badges-spec § 13 |
| 3 | 統合 API レスポンス例 | `lv-v1-implementation-plan.md` に集約 | implementation-plan |
| 4 | 仕様書整合性 (C2, C8) | lv-v1-spec § 12 で `mq_experience` 確定済み | lv-v1-spec § 8 / § 12 |
| 5 | 田丸さん補正 | B3 補正で `nurture_gold` に分類、Lv.12 は仕様通り | lv-v1-spec § 11.3 / customer-segment-spec § 12.2 |
| 6 | reliability / source 概念 | 3段階定義（high/medium/low）と source 3値（visits/mixed/visit_count_fallback）導入 | lv-v1-spec § 13 / § 14 |
| 7 | VIP の B3 適用 | β案: `lifetime_ltv_observed` のみ fallback、`annual_ltv` は visits 必須 | vip-badges-spec § 13 |

---

**完了報告**:
- ファイル: `/docs/lv-v1-implementation-readiness.md`
- 重大リスク B1, B2 は **2026-04-27 ヒロキ確定により解消**
- 実装プランは `docs/lv-v1-implementation-plan.md` に分離
- DB / コードへの書き込みは一切なし（読み取り SELECT のみで集計）
