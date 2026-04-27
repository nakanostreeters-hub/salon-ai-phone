# Maikon Quest — 顧客セグメント判定仕様書

**対象**: Lv / VIP バッジとは別軸の、**LTV × 関係の健全性** 軸による 5 セグメント判定
**スコープ**: 新規モジュール（`services/customerSegment.js` 想定）、customers テーブル既存 `customer_segment` との統合方針を含む
**最終更新**: 2026-04-27（B1=B採用 / B3 暫定補正を追記）

> 本仕様の **すべての閾値（LTV高低判定・健全性判定）はサロン毎に上書き可能**。
> 詳細は `docs/salon-config-specification.md` を参照。

---

## 1. 設計思想

- **スタッフの行動指針に直結するセグメント分類**
  - Lv は「お客様の状態表示」
  - VIP バッジは「お客様自身に見せる称号」
  - **セグメント** は「スタッフがどう動くべきかの判断材料」
- **LTV（お金の貢献）× 関係の健全性（周期の崩れ具合）** の 2×2 マトリクス + 来店2回未満の専用枠
- 既存の `customer_segment`（新規 / 固定 / 新規失客 / 固定失客）とは **別カラム** として共存させる
  - 既存は「生データから導かれる客観分類」
  - 新規は「戦略判断のためのアクション分類」

---

## 2. セグメント定義（5種）

|                     | 健全（周期内）     | 離脱傾向（周期逸脱）     |
| ------------------- | ------------------ | ------------------------ |
| **高 LTV**          | 🛡️ **守るVIP**     | 💎 **育てる金脈**         |
| **低 LTV**          | 🌱 **安定層**      | 🍃 **ご様子見**           |
| **判定不能(visits<2)** | 👀 **見守り層**                            ||

### 2.1 守るVIP

- 条件: LTV 上位 × 周期健全
- 状態: 現状最良。離脱させないためのメンテが最優先
- 戦略: 既存の関係性を維持。サプライズ施策より安定優先

### 2.2 育てる金脈

- 条件: LTV 上位 × 周期逸脱（ご無沙汰）
- 状態: **もっとも即時アクションが必要なセグメント**。ここを復活させれば LTV が戻る
- 戦略: 電話 / LINE で積極的にリーチ。個別対応・記念カラー等の特別提案

### 2.3 安定層

- 条件: LTV 下位〜中位 × 周期健全
- 状態: 定着はしているが、単価が伸びていない
- 戦略: アップセル（トリートメント・店販）提案、メニュー紹介

### 2.4 ご様子見 (旧「さよなら層」)

- 条件: LTV 下位 × 周期逸脱
- 状態: 自然離脱の可能性大。コスト投下の優先度は低い
- 戦略: 一斉送信で十分。個別対応コストは割かない
- **命名意図**: スタッフ視点で「強すぎる別れ表現」を避け、観察対象であることを示す

### 2.5 見守り層 (新規)

- 条件: 来店2回未満 (`visits.length < 2`)
- 状態: 周期が算出できないため、健全性評価ができない新規〜超初期顧客
- 戦略: 2回目来店までしっかり関係構築。個人周期がわかるまでは「リピーター化」を最優先目標に
- **命名意図**: 「無評価」ではなく「これからを見守る」というポジティブな枠として位置づけ

---

## 3. 判定ロジック（擬似コード）

```js
function determineSegment(customer, visits, salonConfig, allCustomersLtv, allCustomersTotalPayment, now = new Date()) {
  const visitsImportedCount = visits.length;
  const fallback = visitsImportedCount < salonConfig.lv.fallback.threshold_high;  // PREMIER: 5

  // --- 早期リターン: 真の新規（visits も visit_count も少ない） ---
  // visit_count >= 2 なら B3 補正で fallback 判定可能。 visit_count < 2 なら本物の新規 → 見守り層
  if (visitsImportedCount < salonConfig.segment.min_visits_for_judgment
      && (customer.visit_count ?? 0) < salonConfig.segment.min_visits_for_judgment) {
    return { segment: 'watch_over', label: '見守り層', reason: 'insufficient_history',
             reliability: 'low', source: 'visit_count_fallback' };
  }

  // --- LTV 軸（B1 確定: 分母は LTV>0 顧客のみ） ---
  let p_ltv, ltvSource;
  if (!fallback) {
    // 純正計算: visits の lifetime_ltv_observed
    const lifetimeLtvObserved = sumLtv(visits, salonConfig.payment_status_excluded);
    p_ltv = percentile(lifetimeLtvObserved, allCustomersLtv.filter(v => v > 0));
    ltvSource = 'visits';
  } else {
    // B3 補正: customers.total_payment を使用（POS由来）
    p_ltv = percentile(customer.total_payment ?? 0,
                       allCustomersTotalPayment.filter(v => v > 0));
    ltvSource = 'customers.total_payment';
  }
  const ltvHigh = p_ltv >= salonConfig.segment.ltv_high_percentile;  // PREMIER: 0.5

  // --- 関係の健全性軸 ---
  let personalCycle, cycleSource;
  if (!fallback) {
    const intervals = computeIntervals(visits);
    personalCycle = trimmedMedian(intervals);   // P10〜P90 でトリム
    cycleSource = 'visits';
  } else {
    personalCycle = customer.visit_cycle_days;  // POS算出値
    cycleSource = 'customers.visit_cycle_days';
  }
  const daysSinceLast = daysBetween(customer.last_visit_at, now);

  // 周期が算出できない / 0 以下 / dsl が不明 → 健全性判定不能
  if (!personalCycle || personalCycle <= 0 || daysSinceLast == null) {
    // visit_count >= 2 だが周期判定不能 → ご様子見にフォールバック（Lv 低スコアのため）
    return { segment: 'gentle_watch', label: 'ご様子見', reason: 'cycle_unavailable',
             reliability: fallback ? 'low' : 'medium',
             source: fallback ? 'visit_count_fallback' : 'mixed' };
  }

  const deviation = (daysSinceLast - personalCycle) / personalCycle;
  const healthy = deviation <= salonConfig.segment.health_deviation_max;  // PREMIER: 0.5

  // --- 2x2 マトリクス ---
  let segKey, segLabel;
  if (ltvHigh && healthy)        { segKey = 'protect_vip';  segLabel = '守るVIP'; }
  else if (ltvHigh && !healthy)  { segKey = 'nurture_gold'; segLabel = '育てる金脈'; }
  else if (!ltvHigh && healthy)  { segKey = 'stable';       segLabel = '安定層'; }
  else                           { segKey = 'gentle_watch'; segLabel = 'ご様子見'; }

  return {
    segment:     segKey,
    label:       segLabel,
    reliability: visitsImportedCount >= salonConfig.lv.fallback.threshold_high ? 'high'
                 : visitsImportedCount >= salonConfig.lv.fallback.threshold_medium ? 'medium'
                 : 'low',
    source:      fallback ? 'visit_count_fallback' : 'visits',
    debug:       { p_ltv, ltvSource, personalCycle, cycleSource, daysSinceLast, deviation },
  };
}
```

**フォールバック詳細**: visits は2件以上だが個人周期が算出できない極端なケース（全 interval が外れ値で trim 後ゼロ件）は、`customers.first_visit_at` / `last_visit_at` / `visit_count` から `(last - first) / (visit_count - 1)` で推定する。B3 補正下では `customers.visit_cycle_days` を直接使用するためこの問題は発生しない。

---

## 4. 判定基準の詳細

### 4.1 LTV の高低判定

- **集計可能LTV (`lifetime_ltv_observed`) のサロン内パーセンタイル** を使用
- **B1 確定: 分母は `lifetime_ltv_observed > 0` の顧客のみ**（lv-v1-spec § 3.1 と整合）。LTV=0 顧客を含めると少額利用が高パーセンタイル化し VIP の意味が弱くなるため除外
- PREMIER MODELS デフォルト閾値: **50%** (`salon_config.segment.ltv_high_percentile = 0.5`)
- 母集団 < 50 のサロンでは絶対閾値（`salon_config.segment.ltv_high_absolute_fallback`）にフォールバック
- VIP バッジ仕様書の `ltv_total_lifetime_observed` をそのまま流用（計算重複を避ける）

**B3 補正時** (visits_imported_count < 5):
- visits 由来の `lifetime_ltv_observed` の代わりに `customers.total_payment`（POS由来）を使用
- 分母も `total_payment > 0` の顧客内パーセンタイル
- 詳細は § 14（B3 補正適用時のセグメント判定）

### 4.2 健全性の判定

- 個人の平均来店周期 × `(1 + health_deviation_max)` を超えて経過していたら「離脱傾向」
- PREMIER MODELS デフォルト: `health_deviation_max = 0.5` → 個人周期の **1.5倍** 超で離脱判定
- 例: 個人周期 30 日 → 45 日以上経過で離脱判定
- 周期が極端な外れ値を含む場合は **intervals の P10〜P90 でトリム** して median を取る（Lv 仕様書と同じ手法）
- 来店2回未満の顧客は判定不可（segment = `watch_over` = 見守り層）

### 4.3 閾値の微調整ポリシー

PREMIER MODELS は上記デフォルト値でリリース。運用データを見て以下を検討:
- LTV パーセンタイル 50% で「高 LTV」が偏る場合は 60% / 40% 等に調整
- 健全性の 1.5 倍閾値も、離脱率実データを見て 1.3 / 1.8 等に調整
- **閾値変更は salon_config の値を書き換えるだけ**でコード改修不要

---

## 5. 戦略メッセージテンプレート

スタッフ向けにキャラカードに表示する一言ガイダンス。

```js
const STRATEGY_MESSAGES = {
  protect_vip: {
    headline:   '大切に、いつも通りお迎えを',
    body:       '関係が安定しているお客様です。変わらぬサービスが最大のおもてなし。さりげない「いつもありがとうございます」を忘れずに。',
    action:     '既存枠の優先確保・指名スタイリストの継続',
    cta_label:  '次回予約枠を確認',
  },
  nurture_gold: {
    headline:   '🔔 ご無沙汰、個別にお声がけを',
    body:       'LTV 上位なのに周期が崩れています。他サロンに流れかけている兆候。LINEや電話で、形式でなく「この人だから」という個別メッセージを。',
    action:     'LINE個別連絡 / 記念施術の提案',
    cta_label:  '💌 個別LINEを作成',
  },
  stable: {
    headline:   'アップセルの提案チャンス',
    body:       '周期は安定しているものの、客単価はまだ伸ばせる余地あり。トリートメント・店販・季節メニューの軽い紹介からはじめて。',
    action:     'ヘッドスパ / 店販 / 新メニュー紹介',
    cta_label:  '提案メニューを表示',
  },
  gentle_watch: {
    headline:   '一斉配信のリストへ',
    body:       '周期が大きく崩れており、自然離脱の可能性が高いお客様。個別対応のコストはかけず、月次キャンペーン一斉LINEで気軽に再来店のきっかけを作る程度に留めるのが賢明です。',
    action:     '月次一斉配信のリスト対象',
    cta_label:  null,
  },
  watch_over: {
    headline:   '👀 まずは2回目の来店を',
    body:       'まだ来店履歴が少なく、関係性は形成中です。次の来店までを丁寧にフォローし、「また来たい」と思ってもらえる体験設計を意識して。',
    action:     '次回予約のひと押し / 担当の継続',
    cta_label:  '次回予約案内を作成',
  },
};
```

---

## 6. キャラカードでの表示デザイン案

### 6.1 表示位置

- **新セクション「💡 スタッフへのひとこと」** を、既存の「🎯 おもてなしのヒント」の **直前** に差し込む
- セグメントによって色分け

```html
<section class="card strategy-card strategy-nurture_gold">
  <h2 class="sec-title">💡 スタッフへのひとこと</h2>
  <div class="strategy-headline">🔔 ご無沙汰、個別にお声がけを</div>
  <div class="strategy-body">LTV 上位なのに周期が崩れています…</div>
  <div class="strategy-action">
    <span class="label">おすすめアクション</span>
    <span class="value">LINE個別連絡 / 記念施術の提案</span>
  </div>
  <button class="cta-btn">💌 個別LINEを作成</button>
</section>
```

### 6.2 色設計

| セグメント   | 背景色     | 文字色     |
| ------------ | ---------- | ---------- |
| 守るVIP      | `#e7f6ee`  | `#2e7a4f`  |
| 育てる金脈   | `#fff3dc`  | `#b56b0e`  |
| 安定層       | `#edf3fb`  | `#3e5c83`  |
| ご様子見     | `#f2f1ec`  | `#777165`  |
| 見守り層     | `#f6f0fb`  | `#6e4d8c`  |

---

## 7. API 返却への追加フィールド

`GET /character/api/:karte_no` に以下を追加:

```json
{
  "segment_v2": {
    "key": "nurture_gold",
    "label": "育てる金脈",
    "ltv_axis": "high",
    "health_axis": "unhealthy",
    "personal_cycle_days": 30,
    "days_since_last": 58,
    "deviation": 0.93,
    "thresholds_used": {
      "ltv_high_percentile":    0.5,
      "health_deviation_max":   0.5
    },
    "strategy": {
      "headline":  "🔔 ご無沙汰、個別にお声がけを",
      "body":      "…",
      "action":    "LINE個別連絡 / 記念施術の提案",
      "cta_label": "💌 個別LINEを作成"
    }
  }
}
```

- 既存 `customer_segment`（新規 / 固定 / 固定失客等）とは **別名**（`segment_v2`）で返す
- 既存 UI は `customer.customer_segment` を参照しているので互換を壊さない
- `thresholds_used` は判定に使われた閾値を返す（デバッグ用 + サロン横展開時の確認用）

---

## 8. DB への保存（推奨）

実装前に最終承認を取る（DDL が必要なため）:

```sql
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS segment_v2_key        text,
  ADD COLUMN IF NOT EXISTS segment_v2_updated_at timestamptz;
```

- `segment_v2_key`: `'protect_vip' | 'nurture_gold' | 'stable' | 'gentle_watch' | 'watch_over' | null`
- 計算は夜間バッチ（VIP バッジと同じタイミングで一緒に）

---

## 9. サロン毎の設定可能項目

`docs/salon-config-specification.md` に詳細を記載するが、本仕様書に関わる項目は次の通り:

```js
// salon_config.segment 抜粋（PREMIER MODELS デフォルト）
{
  segment: {
    ltv_high_percentile:        0.5,        // LTV上位/下位の境
    ltv_high_absolute_fallback: 50_000,     // 母集団<50時の絶対閾値
    health_deviation_max:       0.5,        // 個人周期の何倍超で離脱判定か
    min_visits_for_judgment:    2,          // これ未満は watch_over
  },
  payment_status_excluded: ['未会計'],
}
```

---

## 10. MVP 実装範囲

| 項目                          | MVP | Phase 2.5 | Phase 3 |
| ----------------------------- | --- | --------- | ------- |
| 5 セグメント判定ロジック       | ✓   |           |         |
| /character/api 返却への追加   | ✓   |           |         |
| キャラカード「ひとこと」表示   | ✓   |           |         |
| DB キャッシュ列追加            | ✓   |           |         |
| 夜間バッチ                    | ✓   |           |         |
| salon_config 参照              | ✓   |           |         |
| 「育てる金脈」へのLINE直リンク  |     | ✓         |         |
| セグメント遷移ログ（履歴）     |     | ✓         |         |
| スタッフ向けセグメント別一覧  |     |           | ✓       |

---

## 11. 既存 `customer_segment` との関係

| カラム                 | 値                                       | 由来           |
| ---------------------- | ---------------------------------------- | -------------- |
| `customer_segment`     | '新規' / '固定' / '新規失客' / '固定失客' | POSインポート  |
| `segment_v2_key` (新)  | 'protect_vip' / 'nurture_gold' / 'stable' / 'gentle_watch' / 'watch_over' | 本仕様書       |

**両者は共存**。既存ロジック（`ai-receptionist.js`、`routes/api.js` の絞り込み等）は `customer_segment` を引き続き参照。**新仕様はキャラカード & スタッフUIのみで利用**。

将来、`customer_segment` を廃止して v2 に統一する場合は別タスクとして切る。

---

## 12. 実データ検証結果（2026-04-27時点・B3 補正適用後）

PREMIER MODELS visits 3,115件で田丸さん(9215) を判定した結果:

| 項目                       | 値                |
|----------------------------|-------------------|
| visits(取込範囲内)         | 1 件              |
| customers.visit_count      | 48 回             |
| customers.total_payment    | ¥326,200（POS由来）|
| customers.visit_cycle_days | 39 日              |
| customers.last_visit_at    | 2025-01-09         |
| 最終来店経過日数           | 472 日 (15.7ヶ月) |
| customers.last_staff       | 金子恵美           |

### 12.1 B3 補正適用前のシミュレーション結果（参考）

`visits.length < 2` のため早期リターン → **見守り層**

→ ヒロキ想定（育てる金脈）と乖離。これがブロッカー B2 の根拠だった。

### 12.2 B3 補正適用後のシミュレーション結果（2026-04-27 確定）

`visitsImportedCount=1 < threshold_high(5)` → **B3 fallback 適用**:

| 判定軸 | 値 / 計算 | 結果 |
|--------|-----------|------|
| **新規判定**: `visits.length < 2 && visit_count < 2`? | 1 < 2 だが visit_count=48 ≥ 2 → 早期リターンしない | watch_over 回避 |
| **LTV 軸 (B3)**: `customers.total_payment` ¥326,200 のパーセンタイル (total_payment>0顧客内) | p ≈ 0.95 ≥ 0.5 | **ltvHigh = true** |
| **健全性軸 (B3)**: `customers.visit_cycle_days`=39, dsl=472 → dev=11.1 | dev >> 0.5 | **healthy = false** |
| **2x2 判定** | ltvHigh=true × healthy=false | **`nurture_gold`（💎 育てる金脈）** |
| **reliability** | visitsImportedCount=1 < 2 | **`low`** |
| **source** | fallback 適用 | **`visit_count_fallback`** |

**所見**: B3 適用により田丸さんは正しく **「育てる金脈」** に分類され、ヒロキ想定と一致。`reliability='low'` フラグで「※暫定値」を UI 表示する。

**対処方針**: B3 暫定補正（§ 14）を MVP に組み込み済み。過去 visits 追加取込により reliability=high になった際は、必要に応じて nurture_gold 判定が変動する可能性がある（visits 履歴次第で healthy 判定が変わる）。

---

## 13. 判断が必要な論点（2026-04-27 確定）

| # | 論点 | 確定内容 |
|---|------|----------|
| 1 | LTV 高低の 50% 閾値 | **MVP は 50% で確定**。`salon_config.segment.ltv_high_percentile = 0.5`。1〜2ヶ月運用後に分布実態を見て再評価 |
| 2 | 健全性の 1.5 倍閾値 | **MVP は 1.5 倍 (`health_deviation_max = 0.5`) で確定**。離脱率実データを見て 1.3 / 1.8 等への調整は salon_config の値書き換えで対応 |
| 3 | `watch_over` 判定条件の補助 | **`visits.length < 2 && customer.visit_count < 2` の両条件で確定（2026-04-27 改訂）**。visit_count が 2 以上なら B3 補正で fallback 判定可能なため、「真の新規」のみ watch_over に分類する |
| 4 | セグメント間の遷移頻度 | **日次更新で確定**。週次に丸めると「育てる金脈」検知の遅延が大きすぎるため、日次バッチで運用 |
| 5 | `gentle_watch` の表記 | **「ご様子見」で確定**。「観察中」「フォロー対象」より柔らかく、スタッフ・顧客の双方に違和感が少ない |
| 6 | 5 セグメント体系の妥当性 | **5 種で確定**（守るVIP / 育てる金脈 / 安定層 / ご様子見 / 見守り層）。旧「さよなら層」を「ご様子見」に改名し、新規初期顧客枠「見守り層」を追加した最終形 |
| 7 | LTV パーセンタイル分母 (B1) | **`LTV > 0` の顧客のみを分母とする（2026-04-27 ヒロキ確定 / B案）**。lv-v1-spec § 3.1 と完全整合 |
| 8 | B3 暫定補正のセグメント適用 | **B3 補正下では `customers.total_payment` と `customers.visit_cycle_days` を使う（2026-04-27 確定）**。詳細は § 14 |

---

## 14. B3 補正適用時のセグメント判定ルール（2026-04-27 確定）

### 14.1 適用条件（lv-v1-spec § 13 と整合）

顧客毎に `visitsImportedCount`（visits テーブルの該当 karte_no 件数、`payment_status='未会計'` 除外後）を集計:

| `visitsImportedCount` | 適用される判定経路                         |
|-----------------------|---------------------------------------------|
| `>= 5` (high)         | 純正計算（visits の interval / lifetime_ltv_observed）|
| `2 〜 4` (medium)     | 純正計算（visits 件数で判定可能）          |
| `< 2` (low)           | **B3 fallback 適用**（customers.* で代用）  |

### 14.2 B3 fallback での判定式

| 軸           | 通常 (high/medium)                           | B3 補正 (low)                                |
|--------------|-----------------------------------------------|-----------------------------------------------|
| LTV 集計     | visits の `lifetime_ltv_observed`              | `customers.total_payment`                     |
| LTV パーセンタイル分母 | LTV>0 顧客の集合                       | `total_payment>0` 顧客の集合                  |
| 個人周期     | visits intervals trimmedMedian                | `customers.visit_cycle_days`                  |
| `dsl`        | `customers.last_visit_at` から計算            | 同左                                          |

### 14.3 早期リターン条件の改訂（重要）

**従来**: `visits.length < 2` で `watch_over` 早期リターン
**改訂後**: `visits.length < 2 && customers.visit_count < 2` の両方を満たす場合のみ `watch_over` 早期リターン

> 理由: visit_count >= 2 ならば B3 補正で 2x2 マトリクス判定が可能。visit_count も < 2 なら本物の新規顧客 → 見守り層が正しい。

### 14.4 reliability / source の返却

`determineSegment` の戻り値に以下を追加:

```js
{
  segment: 'nurture_gold',
  label:   '育てる金脈',
  reliability: 'low',                    // high | medium | low
  source:      'visit_count_fallback',   // visits | mixed | visit_count_fallback
}
```

API レスポンス (`/character/api/:karte_no` の `segment_v2`) にも同フィールドを含める。UI では reliability=low の場合のみ「※」マーク表示（lv-v1-spec § 13.6 と整合）。

### 14.5 過去 visits 取込後の再計算

lv-v1-spec § 13.5 と同じ運用。`init-mq-lv-v1.js --recalc` でセグメントも一緒に再計算される（同一バッチ内で連動）。
