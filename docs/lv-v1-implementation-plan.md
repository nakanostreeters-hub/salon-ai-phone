# Lv v1 実装プラン

**目的**: ヒロキ確定済み方針（B案 + B3案 + P1〜P7 + β案）に基づき、Lv v1 を実装する具体的手順
**前提**: ブロッカー B1, B2 は 2026-04-27 解消済み（`docs/lv-v1-implementation-readiness.md` § 0.1 参照）
**作成日**: 2026-04-27
**スコープ**: 実装ファイル順序・依存関係・行数見積・ロールバック手順・動作確認チェックリスト

---

## 0. 実装方針サマリー（確定）

| 項目                     | 確定内容                                                            |
|--------------------------|---------------------------------------------------------------------|
| LTV パーセンタイル分母 (B1) | **`LTV > 0` の顧客のみ**                                             |
| visits 充足率対応 (B2)    | **B3 暫定補正**（visits<5 で customers.* fallback）                  |
| reliability 3段階         | high (visits≥5) / medium (2〜4) / low (<2)                          |
| score source 3値          | `visits` / `mixed` / `visit_count_fallback`                          |
| UI ※マーク表示           | reliability='low' or source='visit_count_fallback' のみ              |
| VIP の B3 適用 (β)        | `lifetime_ltv_observed` のみ fallback、`annual_ltv` は visits 必須   |
| 再計算トリガー            | MVP は手動（`init-mq-lv-v1.js --recalc`）、Phase 2.5 で自動化         |
| salon_config の DB 化     | MVP は B案（設定ファイル）、サロン追加時に A案へ移行                 |

---

## 1. 実装ファイルリスト（順序付き）

### 1.1 着手順序

依存関係を考慮した推奨着手順序:

| 順 | ファイル                                  | 種別     | 役割                                  | 依存                       |
|----|-------------------------------------------|----------|---------------------------------------|----------------------------|
| 1  | `scripts/migrate-mq-lv-v1.sql`           | 新規     | DB スキーマ追加（15カラム）          | なし                       |
| 2  | `services/salonConfig.js`                | 新規     | サロン設定オーバーライド機構          | なし                       |
| 3  | `services/questEngine.js`                | 書換     | Lv 算出ロジック新式化                  | salonConfig                |
| 4  | `services/vipBadges.js`                  | 新規     | VIP バッジ判定                         | salonConfig                |
| 5  | `services/customerSegment.js`            | 新規     | 5 セグメント判定                       | salonConfig                |
| 6  | `scripts/init-mq-lv-v1.js`               | 新規     | バッチ初期計算（二段フェッチ）         | 全サービス                 |
| 7  | `routes/character.js`                    | 書換     | API レスポンス拡張                     | 全サービス                 |
| 8  | `public/character.html`                  | 書換     | UI（成長段階・VIP・セグメント・※）   | API                        |
| 9  | （旧）`scripts/init-mq-levels.js`        | 廃止     | Phase 0 用、削除推奨（git で履歴保持）| 不要                       |

### 1.2 各ファイルの変更行数見積

| 順 | ファイル                          | 規模見積                         | 内訳                                                    |
|----|-----------------------------------|----------------------------------|---------------------------------------------------------|
| 1  | `migrate-mq-lv-v1.sql`           | 新規 +35 行                       | ALTER TABLE 15カラム + index 3本 + BEGIN/COMMIT          |
| 2  | `services/salonConfig.js`        | 新規 +120 行                      | DEFAULT_CONFIG 80行 + getSalonConfig 20行 + deepMerge 20行 |
| 3  | `services/questEngine.js`        | 既存147 → 約330（**+183 行**）  | calcLvScore 新規 +120行、breakdown 構築 +30行、fallback 分岐 +30行 |
| 4  | `services/vipBadges.js`          | 新規 +90 行                       | computeVipBadges 60行 + B3 fallback 分岐 30行            |
| 5  | `services/customerSegment.js`    | 新規 +130 行                      | determineSegment 80行 + fallback 分岐 30行 + STRATEGY_MESSAGES 20行 |
| 6  | `scripts/init-mq-lv-v1.js`       | 新規 +400 行                      | 二段フェッチ 100行 + パーセンタイル計算 80行 + UPDATE 100行 + dry-run 出力 120行 |
| 7  | `routes/character.js`            | 既存123 → 約180（**+57 行**）   | vip / segment_v2 / mq_lv_* フィールド追加               |
| 8  | `public/character.html`          | 既存 → +約 350 行                | 成長段階 +279, VIP +30, segment +30, ※マーク +10        |

**合計**: 約 **1,375 行**（うち SVG 文字列が +200 行を占める）

### 1.3 依存グラフ

```
salonConfig.js (no deps)
     ↓
   ┌─────────────────────────────────────────┐
   ↓                ↓                ↓        ↓
questEngine    vipBadges    customerSegment   (migrate.sql は並行可)
     ↓                ↓                ↓
     └────────────────┼────────────────┘
                      ↓
              init-mq-lv-v1.js
                      ↓
              routes/character.js
                      ↓
              public/character.html
```

各サービスは salonConfig を引数で受け取る純粋関数として設計。互いに独立しており並列開発可能。

---

## 2. 統合 API レスポンス例（全 3 仕様書合成）

`GET /character/api/:karte_no` の最終形。lv-v1-spec / vip-badges-spec / customer-segment-spec の合成:

```json
{
  "success": true,
  "customer": {
    "id": 7,
    "karte_no": 9215,
    "name": "田丸 弘美",
    "customer_segment": "固定失客",
    "visit_count": 48,
    "first_visit_at": "2019-06-11T10:25:30+00:00",
    "last_visit_at": "2025-01-09T10:00:00+00:00",
    "stylist": null,
    "mq_level": 12,
    "mq_experience": 2743,
    "mq_animal": "sheep",
    "mq_personality": "ふつう",
    "mq_state": "おやすみ",
    "mq_titles": [],
    "mq_type_4letter": "INFJ",
    "mq_type_nickname": "静かな賢者",

    "mq_lv_score": 57.30,
    "mq_lv_breakdown": {
      "visits_imported_count": 1,
      "elements": {
        "freq":       { "raw": { "vc": 48, "vl365": 0 }, "p_total": 0.994, "p_recent": 0,    "score": 12.42, "fallback_applied": true },
        "ltv":        { "raw": { "ltv": 326200, "source": "customers.total_payment" }, "p_ltv": 0.95, "score": 28.50, "fallback_applied": true },
        "cycle":      { "raw": { "cycle_days": 39, "dsl": 472, "source": "customers.visit_cycle_days" }, "deviation": 1.0, "score": 0,    "fallback_applied": true },
        "tenure":     { "raw": { "years": 6.88 }, "score": 6.88, "fallback_applied": false },
        "stylist":    { "raw": { "top_staff_ratio": 0.7, "source": "customers.last_staff" }, "score": 7.00, "fallback_applied": true },
        "engagement": { "raw": { "default": 2.5 }, "score": 2.50, "fallback_applied": false }
      },
      "total": 57.30,
      "level": 12,
      "stage": "child"
    },
    "mq_lv_score_source": "visit_count_fallback",
    "mq_lv_reliability": "low",
    "mq_lv_calculated_at": "2026-04-27T03:00:00+00:00",
    "mq_last_stage_up_at": null
  },

  "badges": [
    { "emoji": "🎖️", "label": "5年クルー" },
    { "emoji": "💎", "label": "48回達成" }
  ],

  "vip": {
    "tier": null,
    "hall_of_fame": false,
    "annual_ltv": 0,
    "lifetime_ltv_observed": 326200,
    "annual_ltv_to_next": 30000,
    "lifetime_source": "customers.total_payment",
    "reliability": "low",
    "annual_ltv_reliability": "low",
    "thresholds_used": {
      "silver": 30000,
      "gold": 60000,
      "platinum": 90000
    }
  },

  "segment_v2": {
    "key": "nurture_gold",
    "label": "育てる金脈",
    "ltv_axis": "high",
    "health_axis": "unhealthy",
    "personal_cycle_days": 39,
    "days_since_last": 472,
    "deviation": 11.1,
    "reliability": "low",
    "source": "visit_count_fallback",
    "thresholds_used": {
      "ltv_high_percentile":    0.5,
      "health_deviation_max":   0.5
    },
    "strategy": {
      "headline":  "🔔 ご無沙汰、個別にお声がけを",
      "body":      "LTV 上位なのに周期が崩れています。他サロンに流れかけている兆候。LINEや電話で、形式でなく「この人だから」という個別メッセージを。",
      "action":    "LINE個別連絡 / 記念施術の提案",
      "cta_label": "💌 個別LINEを作成"
    }
  }
}
```

---

## 3. 実装手順詳細（ステップバイステップ）

### Step 1 — `scripts/migrate-mq-lv-v1.sql` 作成（推定 30 分）

```sql
BEGIN;

ALTER TABLE public.customers
  -- Lv v1 関連
  ADD COLUMN IF NOT EXISTS mq_lv_score                  numeric(5,2),
  ADD COLUMN IF NOT EXISTS mq_lv_breakdown              jsonb,
  ADD COLUMN IF NOT EXISTS mq_lv_score_source           text,         -- 'visits' | 'mixed' | 'visit_count_fallback'
  ADD COLUMN IF NOT EXISTS mq_lv_reliability            text,         -- 'high' | 'medium' | 'low'
  ADD COLUMN IF NOT EXISTS mq_lv_calculated_at          timestamptz,
  ADD COLUMN IF NOT EXISTS mq_last_stage_up_at          timestamptz,
  -- VIP 関連
  ADD COLUMN IF NOT EXISTS ltv_total_annual             integer,
  ADD COLUMN IF NOT EXISTS ltv_total_lifetime_observed  integer,
  ADD COLUMN IF NOT EXISTS vip_tier                     text,
  ADD COLUMN IF NOT EXISTS vip_hall_of_fame             boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS vip_lifetime_source          text,         -- 'visits' | 'customers.total_payment'
  ADD COLUMN IF NOT EXISTS vip_reliability              text,
  ADD COLUMN IF NOT EXISTS vip_updated_at               timestamptz,
  -- セグメント関連
  ADD COLUMN IF NOT EXISTS segment_v2_key               text,
  ADD COLUMN IF NOT EXISTS segment_v2_updated_at        timestamptz;

CREATE INDEX IF NOT EXISTS idx_customers_mq_lv_score    ON public.customers (mq_lv_score);
CREATE INDEX IF NOT EXISTS idx_customers_vip_tier       ON public.customers (vip_tier);
CREATE INDEX IF NOT EXISTS idx_customers_segment_v2     ON public.customers (segment_v2_key);

COMMIT;
```

**確認ポイント**:
- 全 ADD は `IF NOT EXISTS` で idempotent
- BEGIN/COMMIT で原子性確保
- 既存カラム（mq_level, mq_experience 等）は触れない
- 既存データへの影響: **ゼロ**

### Step 2 — `services/salonConfig.js` 新規作成（推定 1 時間）

salon-config-spec § 4 の PREMIER_MODELS_CONFIG をハードコード。`getSalonConfig(salonId)` は深いマージで設定を返す純粋関数。

**確認ポイント**:
- `salon-config-spec § 4` の値と完全一致
- `lv.fallback.*` が確実に含まれている
- 単体テスト: `getSalonConfig('premier-models')` の戻り値検証

### Step 3 — `services/questEngine.js` 書換（推定 3〜4 時間）

**置換対象**:
- `calcExperience()` → 削除（旧式互換用に保持してもよいが、推奨は削除）
- `calcLevel(exp)` → `calcLevel(score)` に変更（`Math.max(1, Math.ceil(score / 5))`）
- `computeCustomerQuest(customer, now)` → 戻り値に `mq_lv_score`, `mq_lv_breakdown`, `mq_lv_score_source`, `mq_lv_reliability` を追加

**新規追加**:
- `calcLvScore(customer, ctx, salonConfig)` — `ctx = { allVisitsByKarte, vcArr, ltvArr, totalPaymentArr, vl365Arr, now }`
- `applyFallback(elementId, customer, ctx, salonConfig)` — 各要素の fallback 分岐
- `determineReliability(visitsImportedCount, salonConfig)` — high/medium/low 判定

**確認ポイント**:
- 6 要素の合計が 0〜100 範囲に収まる
- fallback 適用時の `breakdown.elements.*.fallback_applied` が `true`
- パーセンタイル計算が `LTV > 0` 顧客のみを分母に取る

### Step 4 — `services/vipBadges.js` 新規作成（推定 1 時間）

vip-badges-spec § 3 の擬似コードに従う。`computeVipBadges(karteNo, customer, visits, salonConfig, now)` を実装。

**確認ポイント**:
- `salonConfig.vip.tiers` を threshold 降順で評価し、最初にマッチする 1 つだけ返す
- B3 fallback 適用時は `lifetime_ltv_observed = customer.total_payment`
- `lifetime_source` を返却（'visits' or 'customers.total_payment'）

### Step 5 — `services/customerSegment.js` 新規作成（推定 1.5 時間）

customer-segment-spec § 3 の擬似コードに従う。早期リターン条件を `visits.length < 2 && customer.visit_count < 2` に改訂。

**確認ポイント**:
- B3 fallback 適用時は `customers.total_payment` と `customers.visit_cycle_days` を使用
- 戻り値に `reliability` と `source` を含む
- STRATEGY_MESSAGES の 5 種が定義されている

### Step 6 — `scripts/init-mq-lv-v1.js` 新規作成（推定 3 時間）

二段フェッチ方式:
1. **第一段階**: 全顧客の生指標（visit_count, visits_last_365d, lifetime_ltv_observed, total_payment, tenure_years, top_staff_ratio, visits_imported_count）を計算
2. **第二段階**: パーセンタイル配列をソートして算出（LTV>0 / total_payment>0 でフィルタ）
3. **第三段階**: 各顧客に `mq_lv_score`, `mq_lv_breakdown`, `mq_lv_score_source`, `mq_lv_reliability`, `vip_*`, `segment_v2_*`, `ltv_total_*` を付与し UPDATE

**実行モード**:
- `--sample` — 田丸さん他 4 名の breakdown 表示（DB 書き込みなし）
- `--dry-run [--limit N]` — 全顧客計算 + 分布表示（DB 書き込みなし）
- `--commit [--limit N]` — 実 UPDATE
- `--recalc` — 全顧客の再計算（過去 visits 取込後に使用）

**処理時間目安**: 11,547 顧客 × 16 並列 UPDATE = 約 30〜90 秒

**確認ポイント**:
- `--sample` で田丸さんの breakdown が `lv-v1-spec § 11.3` と一致
- `--dry-run` の Lv 分布が想定通り（85% egg は visits 充足率の問題、B3 補正後は改善見込み）
- `--commit --limit 100` で先頭 100 件をテスト → 全件 dry-run → 全件 commit の 3 段階

### Step 7 — `routes/character.js` 書換（推定 1 時間）

`GET /character/api/:karte_no` の返却 JSON に以下を追加:
- `customer.mq_lv_score`, `customer.mq_lv_breakdown`, `customer.mq_lv_score_source`, `customer.mq_lv_reliability`
- 最上位 `vip` (vip-badges-spec § 5)
- 最上位 `segment_v2` (customer-segment-spec § 7)

**確認ポイント**:
- `mq_lv_score == null` の顧客（バッチ未実行）でも 500 エラーにならないこと
- 既存 `customer.mq_level`, `customer.mq_experience` を破壊しない（後方互換）

### Step 8 — `public/character.html` 書換（推定 半日 = 4 時間）

growth-stage-spec § 4-1 の通り 7 か所変更:
- `<style>` に `.stage-chip`, `.next-evolve-hint`, `.reliability-mark`, `.strategy-card` 追加
- `ANIMAL_STAGE_SVG` 定数（5 段階 × 3 動物 = 15 SVG）追加
- `STAGE_META` 定数追加
- `renderCard()` に segment_v2 / VIP / 段階チップ / 次の進化 / ※マーク描画追加
- フォールバック処理: `mq_lv_score == null` → 既存表示、`mq_animal` 未対応 → child SVG

**確認ポイント**:
- `mq_lv_reliability='low'` の場合のみ ※ マーク表示
- ホバー／タップで暫定値説明ツールチップ
- お客様向け表示（顧客直接表示時）には ※ を出さない判定（運用フラグ）

### Step 9 — 動作確認（推定 1〜2 時間）

`§ 5 動作確認チェックリスト` を参照。

---

## 4. ロールバック手順

### 4.1 バックアップ取得（必須）

**推奨**: Supabase ブランチを作成（mcp__claude_ai_Supabase__create_branch）

代替案: pg_dump or JSON エクスポート（readiness.md § 4.1 参照）

### 4.2 各ステップの戻し方

| 失敗ステップ            | 戻し方                                                            |
|-------------------------|-------------------------------------------------------------------|
| Step 1（マイグレ）失敗  | BEGIN/COMMIT で自動 ROLLBACK。部分適用なら DROP COLUMN IF EXISTS  |
| Step 2–5（コード追加）  | git revert で復旧                                                |
| Step 6（バッチ）失敗    | バックアップ JSON から `mq_level` を復元、新規カラムは UPDATE で NULL 化 |
| Step 7（API）失敗       | git revert。バッチデータは残る（無害）                            |
| Step 8（UI）失敗        | git revert。フロントだけのため影響範囲狭い                        |

### 4.3 緊急時の DB 完全復元

```sql
BEGIN;
ALTER TABLE public.customers
  DROP COLUMN IF EXISTS mq_lv_score,
  DROP COLUMN IF EXISTS mq_lv_breakdown,
  DROP COLUMN IF EXISTS mq_lv_score_source,
  DROP COLUMN IF EXISTS mq_lv_reliability,
  DROP COLUMN IF EXISTS mq_lv_calculated_at,
  DROP COLUMN IF EXISTS mq_last_stage_up_at,
  DROP COLUMN IF EXISTS ltv_total_annual,
  DROP COLUMN IF EXISTS ltv_total_lifetime_observed,
  DROP COLUMN IF EXISTS vip_tier,
  DROP COLUMN IF EXISTS vip_hall_of_fame,
  DROP COLUMN IF EXISTS vip_lifetime_source,
  DROP COLUMN IF EXISTS vip_reliability,
  DROP COLUMN IF EXISTS vip_updated_at,
  DROP COLUMN IF EXISTS segment_v2_key,
  DROP COLUMN IF EXISTS segment_v2_updated_at;
-- mq_level の旧式値復元はバックアップ JSON から個別 UPDATE 必須
COMMIT;
```

### 4.4 推奨運用

- Step 1 と Step 6（commit）は同日に連続実行しない
- Step 6 commit は `--limit 100` → 全件 dry-run → 全件 commit の 3 段階
- Step 1 → 翌日 Step 6 dry-run → さらに翌日 Step 6 commit がフェイルセーフ

---

## 5. 動作確認チェックリスト

### 5.1 着手前

- [ ] `docs/lv-v1-implementation-readiness.md` のブロッカー解消ステータスを確認
- [ ] バックアップ取得（推奨: Supabase ブランチ）
- [ ] `salon-config-spec § 4` の値が PREMIER_MODELS_CONFIG と一致

### 5.2 各 Step 完了時

- [ ] **Step 1**: 15 カラム追加が `IF NOT EXISTS` で安全に流せた
- [ ] **Step 2**: `getSalonConfig('premier-models')` が § 4 の値と完全一致
- [ ] **Step 3**: `calcLvScore` の単体テスト（境界値・空配列・fallback 全パターン）通過
- [ ] **Step 4**: `computeVipBadges` の単体テスト（B3 fallback 適用 / 非適用）通過
- [ ] **Step 5**: `determineSegment` の単体テスト（5 セグメント全パターン + watch_over 改訂条件）通過
- [ ] **Step 6.1**: `--sample` で田丸さんの breakdown が `lv-v1-spec § 11.3` と一致
- [ ] **Step 6.2**: `--dry-run` の Lv 分布が出力される
- [ ] **Step 6.3**: `--commit --limit 100` で先頭 100 件 commit 成功
- [ ] **Step 6.4**: `--commit` で全 11,547 件 commit 成功
- [ ] **Step 7**: `mq_lv_score == null` 顧客で API が 500 にならない
- [ ] **Step 7**: 既存フィールド（mq_level, mq_experience）が破壊されていない
- [ ] **Step 8**: `mq_lv_score == null` 顧客で従来表示にフォールバックする

### 5.3 着手後（実機確認）

- [ ] `/character/9215` 田丸さんが想定通り（Lv.12 / 🐥 / 💎 nurture_gold / ※マーク）で表示
- [ ] 上位 10 名（吾妻恵 / 中野翼 / 神野るみこ ...）を順に開いて異常なし
- [ ] visits 取込ゼロ顧客で ※マークが表示される
- [ ] visits 充足度 high の顧客では ※マークが**表示されない**
- [ ] お客様向け表示モード（あれば）で ※マークが**非表示**
- [ ] 既存 `customer_segment` を参照する箇所（ai-receptionist.js / routes/api.js）が壊れていない

### 5.4 1〜2 週間後（運用確認）

- [ ] サロンスタッフからの「常連が卵に見える」フィードバックが出ていない
- [ ] reliability=low 顧客の比率が想定内（visits 充足率 5.15% から推定）
- [ ] segment_v2 の分布がスタッフの肌感覚と一致
- [ ] VIP 階層の該当人数が vip-badges-spec § 2 の推定（シルバー約100/ゴールド約30/プラチナ約9）と整合

---

## 6. 1ファイル目から順に着手する場合の所要時間目安

| Step                       | 工数             | 備考                                  |
|----------------------------|------------------|---------------------------------------|
| Step 1（マイグレ）          | 30 分            |                                       |
| Step 2（salonConfig.js）    | 1 時間           |                                       |
| Step 3（questEngine.js）    | 3〜4 時間        | パーセンタイル計算 + B3 fallback 分岐 |
| Step 4（vipBadges.js）      | 1 時間           |                                       |
| Step 5（customerSegment.js）| 1.5 時間         |                                       |
| Step 6（init-mq-lv-v1.js）  | 3 時間           | 二段化 + dry-run 動作確認             |
| Step 7（character.js API）  | 1 時間           |                                       |
| Step 8（character.html）    | 半日（4 時間）   | growth-stage-spec § 5 の見積準拠      |
| Step 9（手作業確認）         | 1〜2 時間        |                                       |
| **合計**                   | **約 2〜2.5 日** | バックアップ取得・テスト工数を含む    |

### 6.1 推奨日程

- **1 日目**: Step 1〜5（マイグレ + 各サービス層）
- **2 日目**: Step 6（バッチ実装 + dry-run + 段階 commit）
- **3 日目**: Step 7〜8（API + UI）+ Step 9（動作確認）

各日終了時に PR を切り、レビュー後に main にマージ。

---

## 7. Phase 2.5 以降の予定タスク（参考）

MVP では実装しないが、設計上の予約スロット:

| 項目                                    | 仕様参照                          | 想定タイミング |
|-----------------------------------------|-----------------------------------|----------------|
| 30日スムージング                         | lv-v1-spec § 7                   | Phase 2.5      |
| visits 取込時の自動再計算フック          | lv-v1-spec § 13.5                | Phase 2.5      |
| 来店登録時の VIP/segment 増分更新        | vip-badges-spec § 4              | Phase 2.5      |
| ⑥ engagement_score の LINE 反応率対応   | lv-v1-spec § 4⑥                  | Phase 2.5      |
| salon_configs テーブル化（A 案移行）    | salon-config-spec § 5.1          | サロン追加時    |
| 過去 visits 追加取込                     | lv-v1-spec § 11.4                | データ拡充次第  |
| 全 8 動物の SVG（5 動物追加）            | growth-stage-spec § 5            | Phase 2.5      |
| 進化演出 (chip_rise) 実装                | growth-stage-spec § 3-4          | Phase 2.3      |

---

## 8. 参照仕様書

- `docs/lv-v1-specification.md` — Lv 算出ロジック本体（§ 13 で B3 暫定補正）
- `docs/vip-badges-specification.md` — VIP バッジ判定（§ 13 で B3 fallback 適用）
- `docs/customer-segmentation-specification.md` — 5 セグメント判定（§ 14 で B3 補正）
- `docs/growth-stage-specification.md` — 5 段階成長 UI（§ 3-3.1 で ※マーク表示）
- `docs/salon-config-specification.md` — サロン毎オーバーライド機構（`lv.fallback.*` パラメータ追加）
- `docs/lv-v1-implementation-readiness.md` — 実装準備状況（B1, B2 解消済み）

---

**完了基準**: §5 動作確認チェックリスト の全項目が ✓ となり、田丸さん(9215)が「Lv.12 / 🐥 こども / 💎 育てる金脈 / ※暫定」と正しく表示されること。
