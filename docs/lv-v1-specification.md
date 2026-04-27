# Maikon Quest — Lv v1 仕様書

**対象**: `services/questEngine.js` の `calcExperience` / `calcLevel` を置き換える、次世代レベル算出ロジック
**スコープ**: Phase 2 MVP に投入可能な範囲で、既存 customers / visits テーブルから導出できる指標で構成する
**最終更新**: 2026-04-27（B1=B採用 / B3 暫定補正を追記）

> 本仕様の **すべての配点・閾値はサロン毎に上書き可能**。
> 詳細は `docs/salon-config-specification.md` を参照。

---

## 1. 設計思想

- Lv は **お客様とサロンの関係の「濃さ」** を一つの数字で表現するための総合スコア
- 「金額の多寡」一軸ではなく、**来店頻度・金額・周期の合致・付き合いの長さ・担当の継続性** を束ねる
- **サロン内相対評価（パーセンタイル正規化）を基本** とする。絶対値（金額・回数）は店舗規模・価格帯に依存するため、サロン母集団の中での位置で評価した方が、Lv の解釈が安定する
- 現行 Phase 0 式（`visit_count × 50 + relation_years × 50 + recencyBonus`）は **Phase 2 で完全置換**

---

## 2. スコア配分（100 点満点）

| 要素                       | 配分  | 指標サマリ                                                   |
| -------------------------- | ----- | ------------------------------------------------------------ |
| ① 来店頻度・累積回数       | 25%   | `visit_count` の相対順位、かつ直近1年の来店回数              |
| ② LTV（観測累計使用金額）  | 30%   | visits テーブルの `treatment_total + retail_total` 累計      |
| ③ 周期適合度               | 20%   | 個人の平均来店周期と、現在の「次回までの経過日数」の一致度   |
| ④ 継続年数 (tenure)        | 10%   | `first_visit_at` から現在までの年数                          |
| ⑤ 担当スタイリスト継続性   | 10%   | 直近 N 回の来店における `main_staff` の集中度                |
| ⑥ エンゲージメント余地     | 5%    | 将来拡張スロット（LINE反応・カウンセリング深度 等）          |
| **合計**                   | 100%  |                                                              |

**Lv 変換**: `Lv = max(1, ceil(score / 5))` （score: 0〜100）
→ score=0 で Lv.1、score=100 で Lv.20、Lv 1 段あたり score 幅 5 ポイントで等幅

**配分は salon_config.lv.weights で上書き可能**（合計100の制約）。

> **設計上の整合性**: この式は `docs/growth-stage-specification.md` の 5 段階成長 (🥚 Lv1–4 / 🐣 Lv5–8 / 🐥 Lv9–12 / 🦁 Lv13–16 / 👑 Lv17–20) と数学的に完全一致する。
> 旧式 `Lv = 1 + floor(score × 19 / 100)` では Lv 4 が score 15.8–21.0 に跨り、🥚 と 🐣 を またいでしまうため、本式で確定。

---

## 3. 用語定義

本仕様書では LTV を以下の2系統で扱う:

| 用語                       | 定義                                          |
| -------------------------- | --------------------------------------------- |
| `lifetime_ltv_observed`    | **visits に取り込まれている範囲の累計LTV**。本仕様書および VIP 仕様書のすべての「累計LTV」はこれを指す。真の累計（来店開始からの全期間）ではないことに留意 |
| `annual_ltv`               | 直近365日の LTV（visits.start_time が `now - 365d` 以降）       |
| `lifetime_ltv_fallback`    | **B3 暫定補正用**。`customers.total_payment`（POS由来の真の累計LTV）。`visits_imported_count < 5` の顧客でのみ使用。詳細は § 13 参照 |

> ⚠️ 旧仕様書での `lifetime_ltv` / `ltv_total` 表記は、すべて `lifetime_ltv_observed` に統一。
> 真の累計LTVは visits の取込範囲拡大が前提条件であり、現在のDBでは算出不可能（理由は § 11 参照）。

### 3.1 パーセンタイル分母の定義（B1 確定: 2026-04-27）

`percentile(x, ALL_customers.X)` は **`X > 0` の顧客のみを分母とする**（LTV=0 や visit_count=0 の顧客は除外）。

- 理由: VIP 判定や Lv は「実際に売上寄与のある顧客群の中での相対評価」であるべき。LTV=0 を分母に含めると、少額利用でも高パーセンタイル化しやすく VIP の意味が弱くなる
- 適用範囲: ② LTV / ① freq の `p_recent` （`visits_last_365d > 0`）/ B3 補正時の `p_ltv`（`total_payment > 0`）すべて
- 例外: ① freq の `p_total` は `visit_count >= 1` の顧客内で評価（visit_count=0 の幽霊カルテ 311 件は除外）
- サロン母集団 < `salon_config.lv.min_population_for_relative` のサロンでは絶対閾値フォールバック（既存 § 7 ルール）

---

## 4. 各要素の計算式

以下はすべて擬似コード。`percentile(x, arr)` は配列 arr の中で x が下位何％に位置するかを 0〜1 で返す関数を指す。除外条件は `salon_config.payment_status_excluded`（PREMIERデフォルト: `['未会計']`）。

### ① 来店頻度・累積回数（25点満点）

```
visit_count           = customers.visit_count
visits_last_365d      = count(visits WHERE karte_no=c.karte_no AND start_time >= now - 365d
                              AND payment_status NOT IN salon_config.payment_status_excluded)

p_total  = percentile(visit_count, ALL_customers WHERE visit_count >= 1)
p_recent = percentile(visits_last_365d, ALL_customers WHERE visits_last_365d > 0)

freq_score = 25 * (0.5 * p_total + 0.5 * p_recent)
```

- 累計回数だけだと「昔通ったが今は来ない人」が高得点になるため、直近1年の来店回数を半分混ぜる
- MVP では `visits_last_365d` を visits テーブルから SQL で計算（毎日一度バッチ）
- 除外条件: `payment_status='未会計'` を除外（② LTV と整合）

**B3 補正時** (visits_imported_count < 5):
- `p_total` はそのまま使用（customers.visit_count は POS 由来で完全）
- `p_recent` は次のフォールバック式で算出:
  ```
  if customers.last_visit_at is within 365 days:
      p_recent_fallback = p_total * 0.7   // 「最近来てる証拠あり、ただし正確な回数は不明」
  else:
      p_recent_fallback = 0
  ```
- 詳細は § 13 を参照

### ② LTV（30点満点）

```
lifetime_ltv_observed = SUM(visits.treatment_total + visits.retail_total)
                        WHERE karte_no=c.karte_no
                          AND payment_status NOT IN salon_config.payment_status_excluded

p_ltv = percentile(lifetime_ltv_observed, ALL_customers WHERE lifetime_ltv_observed > 0)

ltv_score = 30 * p_ltv
```

- `treatment_total` / `retail_total` は税込。null は 0 として扱う
- 除外: `'未会計'` のみ（実データで取消/キャンセル系の値は確認されず）
- **分母は `lifetime_ltv_observed > 0` の顧客のみ**（B1 確定 / § 3.1 参照）
- MVP ではサロン内パーセンタイル。将来は店舗横断母集団でも可

**B3 補正時** (visits_imported_count < 5):
- visits 由来の `lifetime_ltv_observed` の代わりに `customers.total_payment`（POS由来）を使用
- 分母も `total_payment > 0` の顧客内パーセンタイル
  ```
  ltv_for_fallback = customers.total_payment   // POS由来、税込
  p_ltv_fallback   = percentile(ltv_for_fallback, ALL_customers WHERE total_payment > 0)
  ltv_score        = 30 * p_ltv_fallback
  ```
- 詳細は § 13 を参照

### ③ 周期適合度（20点満点）

```
intervals = [visits[i].start_time - visits[i-1].start_time for i in 2..n]
personal_cycle_days = trimmedMedian(intervals, p10=0.1, p90=0.9)

days_since_last   = today - last_visit_at
deviation         = abs(days_since_last - personal_cycle_days) / personal_cycle_days

cycle_score = 20 * max(0, 1 - deviation)
```

- 来店2回未満の顧客は `cycle_score = 0`（判定不能）
- `deviation` は 1.0 でクリップ
- 個人周期が極端に短い／長い場合の外れ値対応として、intervals の P10〜P90 でトリムしてから median を取る

**B3 補正時** (visits_imported_count < 5):
- visits の interval 計算の代わりに `customers.visit_cycle_days`（POS が既に算出している値）を使用
- `days_since_last` は `customers.last_visit_at` から計算
  ```
  cycle_for_fallback = customers.visit_cycle_days
  if cycle_for_fallback is null OR cycle_for_fallback <= 0:
      cycle_score = 0   // POS 側でも周期算出不能 → 0
  else:
      days_since_last = today - customers.last_visit_at
      deviation       = abs(days_since_last - cycle_for_fallback) / cycle_for_fallback
      cycle_score     = 20 * max(0, 1 - min(1, deviation))
  ```
- 詳細は § 13 を参照

### ④ 継続年数 tenure（10点満点）

```
tenure_years = (now - first_visit_at) / 365.25
tenure_score = 10 * min(1, tenure_years / salon_config.lv.tenure_max_years)   // PREMIER: 10
```

- すでに `questEngine.js` 内に `yearsBetween` があるのでそのまま流用
- PREMIER MODELS は10年で満点。サロンの開業年数によってオーバーライド可

### ⑤ 担当スタイリスト継続性（10点満点）

```
recent_visits   = visits WHERE karte_no=c.karte_no
                    AND payment_status NOT IN salon_config.payment_status_excluded
                  ORDER BY start_time DESC
                  LIMIT salon_config.lv.stylist_window  // PREMIER: 10
staff_counts    = count by main_staff in recent_visits
top_staff_ratio = max(staff_counts) / recent_visits.length

stylist_score = 10 * top_staff_ratio
```

- 「直近10回のうち最も多く担当したスタイリストの占有率」が 1.0 なら満点、0.1 (全部バラバラ) で 1 点
- `main_staff` が null の行はカウントから除外
- 訪問回数 < 3 の場合は `stylist_score = 5 * top_staff_ratio`（判定サンプル不足に配慮して上限を下げる）
- 除外条件: `payment_status='未会計'` を除外（② LTV と整合）

**B3 補正時** (visits_imported_count < 5):
- visits の main_staff 集中度は計算不能のため、`customers.stylist` または `customers.last_staff` の存在で推定
  ```
  if customers.stylist is non-null OR customers.last_staff is non-null:
      top_staff_ratio_fallback = 0.7   // 「担当スタイリストが記録されている = ある程度継続している」中立値
  else:
      top_staff_ratio_fallback = 0
  stylist_score = 10 * top_staff_ratio_fallback
  ```
- 0.7 は salon_config で上書き可（`lv.fallback.stylist_ratio_default`）
- 詳細は § 13 を参照

### ⑥ エンゲージメント余地（5点満点・将来拡張）

```
// MVP: 固定 2.5（中立値）を入れておく。将来 LINE 既読・カウンセリング深度等で置換
engagement_score = 2.5
```

- LINE 応答率、カウンセリング回答完了率、SNS 投稿への反応等を将来取り込むための予約スロット
- MVP では全員 2.5 点固定（Lv への影響は一律バイアスとなり順位は変わらない）

---

## 5. 必要なデータソース

### 5.1 通常計算（visits 主軸）

| 指標            | テーブル   | カラム                                                 | 備考                         |
| --------------- | ---------- | ------------------------------------------------------ | ---------------------------- |
| 累計来店        | customers  | `visit_count`                                          | 既存                         |
| 直近1年来店     | visits     | `karte_no`, `start_time`, `payment_status`             | COUNT 集計                   |
| LTV             | visits     | `treatment_total`, `retail_total`, `payment_status`    | SUM 集計                     |
| 個人周期        | visits     | `karte_no`, `start_time`                               | 時系列から interval を算出   |
| 最終来店        | customers  | `last_visit_at`                                        | 既存                         |
| tenure          | customers  | `first_visit_at`                                       | 既存                         |
| 担当継続性      | visits     | `main_staff`, `start_time`                             | 直近 10 件で集計             |

### 5.2 B3 暫定補正用（visits_imported_count < 5 で使用）

| 指標            | テーブル   | カラム                                                  | 用途                         |
| --------------- | ---------- | ------------------------------------------------------- | ---------------------------- |
| 補正LTV         | customers  | `total_payment`                                         | ② LTV の fallback（POS由来）|
| 補正周期        | customers  | `visit_cycle_days`                                      | ③ cycle の fallback（POS算出）|
| 補正担当継続性  | customers  | `stylist`, `last_staff`                                 | ⑤ stylist の fallback        |

**追加 DDL は不要**（既存カラムだけで MVP は完結）。
MVP 後に ⑥ を実装する段階で、別テーブル `mq_engagement_stats` などを新設する可能性はあり。

---

## 6. Lv 境界（1〜20）

score → Lv: `Lv = max(1, ceil(score / 5))`（半開区間 `(prev, curr]`）

| score 範囲     | Lv   | 成長段階   | 想定イメージ                                  |
| -------------- | ---- | ---------- | --------------------------------------------- |
| 0 – 5.0        | 1    | 🥚 たまご   | 新規・ほぼ接点なし                            |
| 5.01 – 10.0    | 2    | 🥚 たまご   | 1〜2回来店                                    |
| 10.01 – 15.0   | 3    | 🥚 たまご   | 様子見フェーズ                                |
| 15.01 – 20.0   | 4    | 🥚 たまご   | 2回目来店が安定                               |
| 20.01 – 25.0   | 5    | 🐣 あかちゃん | リピーター化初期                              |
| 25.01 – 30.0   | 6    | 🐣 あかちゃん | 定着初期                                      |
| 30.01 – 35.0   | 7    | 🐣 あかちゃん | 中堅リピーター（**実データ反映後の田丸さんはLv.7**）|
| 35.01 – 40.0   | 8    | 🐣 あかちゃん | 月1前後の常連                                 |
| 40.01 – 45.0   | 9    | 🐥 こども   | 5年前後の付き合い                             |
| 45.01 – 50.0   | 10   | 🐥 こども   | 10年越えの道                                  |
| 50.01 – 55.0   | 11   | 🐥 こども   | 中堅VIP候補                                   |
| 55.01 – 60.0   | 12   | 🐥 こども   | 高LTV域                                       |
| 60.01 – 65.0   | 13   | 🦁 おとな   | 上位10%                                       |
| 65.01 – 70.0   | 14   | 🦁 おとな   | サロンを支える層                              |
| 70.01 – 75.0   | 15   | 🦁 おとな   | シルバー VIP 候補                             |
| 75.01 – 80.0   | 16   | 🦁 おとな   | ゴールド VIP 候補（**当初概算の田丸さんはLv.16**）|
| 80.01 – 85.0   | 17   | 👑 マスター | プラチナ VIP 候補                             |
| 85.01 – 90.0   | 18   | 👑 マスター | 殿堂入り候補                                  |
| 90.01 – 95.0   | 19   | 👑 マスター | 殿堂クラス                                    |
| 95.01 – 100    | 20   | 👑 マスター | パーフェクト（全指標トップ）                  |

> 境界幅は **5 ポイント等幅**。Lv 4 段ごとに成長段階が 1 段階上がる対応関係を厳密に保つ。

---

## 7. パーセンタイル運用方針

- パーセンタイルは **1回/日のバッチ** でサロン単位に再計算して customers に書き込む（新カラム `mq_lv_score` / `mq_lv_breakdown jsonb`）
- 新規顧客だけ大量に増えるタイミングがあっても、現状の Lv が日次で揺れすぎないよう **30日スムージング**（前日値と新値の加重平均 0.7 : 0.3）を適用
- 母集団サイズ <50 のサロンでは percentile が不安定なため、その場合は MVP 期間中は絶対閾値版にフォールバック（将来課題）

---

## 8. 既存コードからの書き換え範囲

### 置き換え対象

- `services/questEngine.js`
  - `calcExperience()` → **新しい `calcLvScore(customer, context, salonConfig)` に置換**
  - `calcLevel()` → 入力が exp ではなく score に変わる
  - `computeCustomerQuest()` → 戻り値に `mq_lv_score` / `mq_lv_breakdown` を追加

### 影響を受ける周辺

- `scripts/init-mq-levels.js`
  - 1 顧客ずつの計算では足りない（パーセンタイル前提のため）
  - **二段フェッチ方式**に書き換え：
    1. 全顧客の生指標（visit_count, lifetime_ltv_observed, tenure, …）を先に計算
    2. 各指標の配列をソートしてパーセンタイル値を算出
    3. 各顧客に score を付与して DB 更新
- `routes/character.js` の `/character/api/:karte_no`
  - 返却 JSON に `mq_lv_score`, `mq_lv_breakdown`, `mq_lv_score_source`, `mq_lv_reliability` を追加（UI 表示は別タスク）
- `scripts/migrate-mq-lv-v1.sql` (新規ファイル / 実装前に最終承認):
  - `ALTER TABLE customers ADD COLUMN mq_lv_score numeric(5,2)`
  - `ALTER TABLE customers ADD COLUMN mq_lv_breakdown jsonb`
  - `ALTER TABLE customers ADD COLUMN mq_lv_score_source text`     -- 'visits' | 'mixed' | 'visit_count_fallback'
  - `ALTER TABLE customers ADD COLUMN mq_lv_reliability text`      -- 'high' | 'medium' | 'low'
  - `ALTER TABLE customers ADD COLUMN mq_lv_calculated_at timestamptz`

### DB 既存カラムとの整合

- `mq_level`: 引き続き 1〜20 の integer として使用（計算式が変わるだけ）
- `mq_experience`: § 12 論点1 で「**廃止せず併存**」確定。新カラム `mq_lv_score numeric(5,2)` を追加し、Phase 2 移行期は併存。Phase 3 で削除を検討

---

## 9. サロン毎の設定可能項目

`docs/salon-config-specification.md` に詳細を記載するが、本仕様書に関わる項目は次の通り:

```js
// salon_config.lv 抜粋（PREMIER MODELS デフォルト）
{
  lv: {
    weights: {
      frequency:  25,   // ① 来店頻度
      ltv:        30,   // ② LTV
      cycle:      20,   // ③ 周期適合度
      tenure:     10,   // ④ 継続年数
      stylist:    10,   // ⑤ 担当スタイリスト継続性
      engagement:  5,   // ⑥ エンゲージメント余地
    },
    tenure_max_years:        10,    // 何年で tenure 満点か
    stylist_window:          10,    // 担当継続性の集計対象（直近何件）
    engagement_default:      2.5,   // ⑥ MVP 固定値
    smoothing_alpha:         0.3,   // 30日スムージングの新値ウェイト（Phase 2.5 まで未使用）
    min_population_for_relative: 50, // 母集団 < これなら絶対閾値フォールバック

    // B3 暫定補正用パラメータ（§ 13）
    fallback: {
      threshold_high:           5,     // visits_imported_count >= これ → reliability=high（補正なし）
      threshold_medium:         2,     // 2〜4 → reliability=medium（一部補正）
                                       // < 2 → reliability=low（主要補正）
      stylist_ratio_default:    0.7,   // ⑤ stylist fallback の中立値
      p_recent_attenuation:     0.7,   // ① p_recent fallback 係数（last_visit ≤ 365d 時）
    },
  },
  payment_status_excluded: ['未会計'],
}
```

---

## 10. MVP で実装する範囲

| 要素                | MVP | Phase 2.5 | Phase 3 |
| ------------------- | --- | --------- | ------- |
| ①来店頻度           | ✓   |           |         |
| ②LTV                | ✓   |           |         |
| ③周期適合度         | ✓   |           |         |
| ④tenure             | ✓   |           |         |
| ⑤スタイリスト継続性 | ✓   |           |         |
| ⑥エンゲージメント   | 固定値 2.5 | LINE反応率を追加 | カウンセリング深度を追加 |
| サロン相対評価      | ✓   |           |         |
| salon_config 参照   | ✓   |           |         |
| 30日スムージング    |     | ✓         |         |
| 絶対閾値フォールバック |  | ✓         |         |

MVP では **ほぼ全要素を実装**（⑥ だけ固定値）。相対評価は必須なので一括バッチ方式で書く。

---

## 11. 田丸さんの再シミュレーション（実データ駆動）

### 11.1 当初概算（2026-04-23時点・visits未取込）

| 項目      | 仮値                  | 配点         |
|-----------|-----------------------|--------------|
| 来店頻度  | 48回 / 12回 (推定)    | 25 × 0.925 = 23.1 |
| LTV       | 約72万円 (推定)       | 30 × 0.85   = 25.5 |
| 周期適合度 | dev=0.5 (推定)       | 20 × 0.5    = 10.0 |
| tenure    | 約5年                 | 10 × 0.5    =  5.0 |
| スタイリスト | 0.9               | 10 × 0.9    =  9.0 |
| ⑥        | 固定                  | 2.5         |
| **合計**  |                       | **75.1 → Lv.16**（🦁 おとな帯）|

### 11.2 B1 採用後（LTV>0 顧客 1,060 人を分母とする）

| 項目      | 実値                  | 配点 |
|-----------|-----------------------|------|
| 来店頻度  | customers.visit_count=48 / visits_last_365d=0 | p_total=高 / p_recent=ほぼ0 → 約 25 × 0.5 = 12.5 |
| LTV       | lifetime_ltv_observed=¥7,500 (取込範囲内のみ) | p=0.378 (LTV>0顧客の中で) → 30 × 0.378 = 11.3 |
| 周期適合度 | visits<2 のため 算出不能 | 0 |
| tenure    | 6.9年 (2019-06-11〜) | 10 × 0.69 = 6.9 |
| スタイリスト | 集計不能 (visits<3) | 0 |
| ⑥        | 固定                  | 2.5 |
| **合計**  |                       | **約 33.2 → Lv.7（🐣 あかちゃん）** |

→ B1 単独では田丸さんは依然 Lv.7。B3 暫定補正（§ 13）の併用が必要。

### 11.3 B1+B3 併用後（暫定補正適用 / 2026-04-27 確定）

田丸さんは `visits_imported_count = 1 < 5` のため **B3 補正適用対象**:

| 項目      | 補正適用後                                    | 配点 |
|-----------|-----------------------------------------------|------|
| 来店頻度  | p_total=高(0.994) / p_recent_fallback = p_total × 0.7 = 0.696（last_visit が 472 日前なので **365日超 → 0**）| 25 × (0.5×0.994 + 0.5×0) = **12.42** |
| LTV (補正)| `customers.total_payment` = ¥326,200 → p_ltv_fallback ≈ 0.95 (total_payment>0 顧客の中で) | 30 × 0.95 = **28.5** |
| 周期 (補正)| `customers.visit_cycle_days`=39, dsl=472 → dev=11.1 → clip 1.0 | **0** |
| tenure    | 6.88年 | **6.88** |
| スタイリスト (補正)| customers.last_staff='金子恵美' → top_staff_ratio=0.7 | 10 × 0.7 = **7.0** |
| ⑥        | 固定 | **2.5** |
| **合計**  | | **57.30 → Lv.12（🐥 こども）** |

**reliability**: `low`（visits_imported_count=1 < 2）
**source**: `visit_count_fallback`

### 11.4 当初想定 Lv.16 → 実 Lv.12 のギャップ

**原因**: visits 取込範囲が16ヶ月に限定されているため、田丸さんの③周期適合度がゼロのまま。本来の累計来店履歴（48回）は B3 で①②④⑤ には反映されたが、③ は実際に「472 日来ていない」事実で 0 となる（仕様通り）。

**この乖離は仕様の欠陥ではなく、データ範囲の制約 ＋ 実際に長期離脱中であるため**。
- Lv は visits の集計を主軸とし、過去 visits の充足度が判定精度を左右する
- 過去履歴の追加取込（カルテくんから2019年以降の visits を再エクスポート）が完全解決手段
- B3 補正は MVP 期の暫定対応。reliability=low フラグで UI に「※」表示し、利用者が暫定値であることを認識できる

### 11.5 既存セグメント `customer_segment = 固定失客` との一致

田丸さんは customers 既存ロジックでも「固定失客」と判定されており、今回の Lv 算出結果（Lv.12、低スコア）と整合する。

`segment_v2_key` は customer-segmentation-spec の B3 補正規則により、**`nurture_gold`（💎 育てる金脈）** と判定される（visit_count>=2 + total_payment 上位 + 周期逸脱）。**既存ロジックおよびユーザー想定（育てる金脈）と矛盾しない**ことが確認できた。

---

## 12. 判断が必要な論点（2026-04-27 確定）

| # | 論点 | 確定内容 |
|---|------|----------|
| 1 | `mq_experience` 列の扱い | **新カラム `mq_lv_score numeric(5,2)` を追加**。`mq_experience` は廃止せず、Phase 2 移行期は併存（旧式互換）。Phase 3 で削除を検討 |
| 2 | Lv 変動の許容速度 | **30日スムージングは Phase 2.5 で実装**。MVP は日次バッチの素値で運用。salon_config.lv.smoothing_alpha は MVP 期未使用 |
| 3 | パーセンタイル計算のタイミング | **夜間バッチ 1 回 / 日**。visits 追加時のインクリメンタル更新は Phase 2.5 |
| 4 | LTV の税抜/税込 | **税込で統一**（CSV 由来の `treatment_total` / `retail_total` がそのまま税込のため、追加処理不要） |
| 5 | `payment_status` のキャンセル値 | **`'未会計'` のみ除外**。実データに取消/キャンセル値は存在せず、`salon_config.payment_status_excluded = ['未会計']` をデフォルトとする |
| 6 | 古参顧客の visits 履歴欠落（田丸さんケース）| **B3 暫定補正を採用（2026-04-27 ヒロキ確定）**。`visits_imported_count < 5` の顧客には customers.* を使った fallback を適用し、reliability/source フラグで暫定値を識別可能にする。詳細は § 13 |
| 7 | Lv 変換式 | **`Lv = max(1, ceil(score / 5))` で確定**。旧式 `1 + floor(score × 19 / 100)` は成長段階境界（score 20/40/60/80）と Lv 境界が不整合のため廃案 |
| 8 | LTV パーセンタイル分母 (B1) | **`LTV > 0` の顧客のみを分母とする（2026-04-27 ヒロキ確定 / B案）**。理由: VIP判定は実際に売上寄与のある顧客群の中での相対評価。LTV=0 を分母に含めると少額利用でも高パーセンタイル化しやすく VIP の意味が弱くなる |
| 9 | reliability / score source の概念 | **3段階定義 (`high` / `medium` / `low`) と source 3値 (`visits` / `mixed` / `visit_count_fallback`) を導入**。詳細は § 13 / § 14 |

---

## 13. B3 暫定補正（2026-04-27 ヒロキ確定）

### 13.1 趣旨

PREMIER MODELS の visits 取込充足率は **5.15%（visits 3,115件 / customers.visit_count 合計 60,457件）** にとどまり、48回来店の田丸さんが「visits 1件」になるなど、**長期固定客が新 Lv 式で過小評価される構造的問題**がある。

過去 visits の追加取込が根本解決だが、それまでの MVP 期は `customers` テーブルに POS から書き込まれている既存値を使った **暫定補正（fallback）** で「常連が🥚たまご扱い」を回避する。

### 13.2 適用条件（P1 反映）

顧客毎に **`visits_imported_count`**（除外条件適用後の visits テーブル件数）を集計し、以下のラダーで補正度合いを決定する:

| `visits_imported_count` | reliability | source                  | 補正適用範囲                         |
|-------------------------|-------------|-------------------------|--------------------------------------|
| `>= 5`                  | `high`      | `visits`                | 補正なし（純正計算）                |
| `2 〜 4`                | `medium`    | `mixed`                 | ⑤stylist のみ補正可。他は visits 主軸 |
| `< 2`                   | `low`       | `visit_count_fallback`  | ①p_recent / ② / ③ / ⑤ をすべて補正  |

**閾値は `salon_config.lv.fallback.threshold_high / threshold_medium` で上書き可能**。

### 13.3 各要素の補正方法（P2〜P5 反映）

| 要素        | high (純正)                           | medium                                     | low (fallback)                                   |
|-------------|---------------------------------------|--------------------------------------------|--------------------------------------------------|
| ① p_total   | `customers.visit_count` rank          | 同左                                       | 同左                                             |
| ① p_recent  | visits_last_365d rank                 | 同左                                       | last_visit_at ≤ 365d なら p_total × 0.7、else 0 |
| ② ltv       | `lifetime_ltv_observed` rank (LTV>0)  | 同左                                       | `customers.total_payment` rank (total_payment>0)|
| ③ cycle     | visits intervals trimmedMedian        | 同左                                       | `customers.visit_cycle_days` を周期とみなす     |
| ④ tenure    | `customers.first_visit_at` から計算   | 同左                                       | 同左                                             |
| ⑤ stylist   | visits の main_staff 集中度            | sample 不足時は `top_staff_ratio_fallback=0.7`（visits 純正併用）| `customers.stylist || last_staff` non-null なら 0.7、null なら 0 |
| ⑥ engagement| 固定 2.5                              | 同左                                       | 同左                                             |

すべての fallback 定数は `salon_config.lv.fallback.*` で上書き可能。

### 13.4 reliability / score source の DB 記録（P7 反映）

§ 8 で追加する customers 新カラム:

| カラム                | 値                                                | 用途                                |
|-----------------------|---------------------------------------------------|-------------------------------------|
| `mq_lv_score`         | numeric(5,2) 0–100                                | Lv 算出スコア                       |
| `mq_lv_breakdown`     | jsonb（6 要素 + raw 値 + percentile 値）          | デバッグ／監査用                    |
| `mq_lv_score_source`  | `'visits'` \| `'mixed'` \| `'visit_count_fallback'`| どの計算経路で算出されたか           |
| `mq_lv_reliability`   | `'high'` \| `'medium'` \| `'low'`                  | UI に「※」アイコン表示するか判定用 |
| `mq_lv_calculated_at` | timestamptz                                       | 最終再計算日時                      |

`mq_lv_breakdown` は以下の構造:

```json
{
  "visits_imported_count": 1,
  "elements": {
    "freq":       { "raw": { "vc": 48, "vl365": 0 }, "p_total": 0.994, "p_recent": 0,    "score": 12.42, "fallback_applied": true },
    "ltv":        { "raw": { "ltv": 326200, "source": "customers.total_payment" }, "p_ltv": 0.95, "score": 28.5, "fallback_applied": true },
    "cycle":      { "raw": { "cycle_days": 39, "dsl": 472, "source": "customers.visit_cycle_days" }, "deviation": 1.0, "score": 0, "fallback_applied": true },
    "tenure":     { "raw": { "years": 6.88 }, "score": 6.88, "fallback_applied": false },
    "stylist":    { "raw": { "top_staff_ratio": 0.7, "source": "customers.last_staff" }, "score": 7.0, "fallback_applied": true },
    "engagement": { "raw": { "default": 2.5 }, "score": 2.5, "fallback_applied": false }
  },
  "total": 57.30,
  "level": 12,
  "stage": "child",
  "source": "visit_count_fallback",
  "reliability": "low"
}
```

### 13.5 過去 visits 追加取込時の再計算ルール（P6 反映）

visits を追加取込した直後、`visits_imported_count` が threshold を跨ぐ可能性があるため、**`mq_lv_score` は再計算が必要**。

**MVP 運用**:
- 手動実行: `node scripts/init-mq-lv-v1.js --recalc`（全顧客の Lv 再計算 + source/reliability 再判定）
- visits 取込フックは **Phase 2.5 で実装**（取込スクリプトに後フックを追加）

**Phase 2.5 自動再計算条件（仕様予告）**:
- visits の INSERT/UPSERT が発生した karte_no を集合に貯める
- 当該 karte_no の `visits_imported_count` を再集計し threshold を跨いだら、その顧客のみ `mq_lv_*` を再計算
- パーセンタイル分母自体は夜間バッチで全体再計算

### 13.6 UI 表示への影響（growth-stage spec § 4-3 と整合）

- `mq_lv_reliability='low'` または `mq_lv_score_source='visit_count_fallback'` の顧客では、**スコア横に「※」アイコン** を表示
- ホバー／タップで「※ visits 取込が少ないため暫定スコアです（過去 visits 取込後に正確な値に更新されます）」とツールチップ
- 段階チップ（🥚🐣🐥🦁👑）自体はそのまま表示（区別マークは別途）
- API レスポンスに `mq_lv_score_source` と `mq_lv_reliability` を含めて、フロントが判定できるようにする

### 13.7 仕様の制約事項

- **③ cycle が 0 になる構造**: B3 適用後でも、customers.last_visit_at が周期を大きく超えている顧客（= 真に長期離脱中）は `cycle_score=0` のまま。これは**正しい挙動**（実際に長期離脱中のため）。Lv が劇的に上がらない代わり、segmentation で `nurture_gold（育てる金脈）` に正しく分類される
- **annual_ltv の補正不可**: VIP判定で使う `annual_ltv` は時系列必須のため、customers から fallback できない。fallback 顧客は VIP 判定が低めに出る（vip-badges-spec § 13 で詳細）
- **reliability='low' 顧客の Lv は将来変動する**: 過去 visits 取込後に大きく Lv が上がる可能性あり。UI の「※」表示はこの将来変動を予告する役割を持つ

---

## 14. confidence / reliability の定義（2026-04-27 確定）

### 14.1 reliability 3段階

| 値        | 条件                                  | UI 表示             |
|-----------|---------------------------------------|---------------------|
| `high`    | visits_imported_count >= 5            | 通常表示（マークなし）|
| `medium`  | 2 <= visits_imported_count <= 4       | 通常表示（マークなし）|
| `low`     | visits_imported_count < 2             | スコア横に **※** マーク |

`medium` は内部的には mixed source だが、UI 上は high と同等扱い（「ある程度信頼できる」）。**※マークは low のみ**（運用負荷を抑え、本当に注意すべき顧客にフォーカス）。

### 14.2 confidence の概念

`confidence` は将来拡張用の予約スロット。MVP では `reliability` と同じ値を返すが、Phase 2.5 以降で以下を統合する想定:

- visits 取込充足率
- カウンセリング情報の有無
- LINE 連携の有無
- 担当スタイリスト記録の網羅度

将来的には `mq_lv_breakdown` に `"confidence": { "factor_a": 0.8, "factor_b": 0.6, "overall": 0.7 }` のような構造で詳細を返す。

MVP 期は `reliability` のみを返却し、`confidence` は Phase 2.5 で追加。
