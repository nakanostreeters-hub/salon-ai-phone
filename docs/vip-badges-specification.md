# Maikon Quest — VIP バッジ仕様書

**対象**: Lv とは独立した、LTV ベースの VIP 顕示バッジ
**スコープ**: `routes/character.js` の `computeBadges()` 拡張、および `/character/api/:karte_no` の返却 JSON 拡張
**最終更新**: 2026-04-27（B3 暫定補正を追記 — `lifetime_ltv_observed` の fallback として `customers.total_payment` を使用）

> 本仕様の **すべての閾値・有効/無効フラグはサロン毎に上書き可能**。
> 詳細は `docs/salon-config-specification.md` を参照。

---

## 1. 設計思想

- **Lv と VIP は独立軸**
  - Lv は「関係の濃さ総合スコア」
  - VIP バッジは「金銭的な貢献額そのもの」を示す直感的な称号
- **3 段階の階層 + 殿堂入り（標準は無効）** で「次のバッジを目指す」動機を設計
- **年間 LTV と累計 LTV の二系統** で評価（単年爆買いも、長年の積み重ねも、どちらも拾う）
- **絶対閾値は実データ駆動**：PREMIER MODELS 3,115件(16ヶ月)分析で、現実的なレンジに調整済み（過去経緯は § 11 参照）
- **サロン毎に閾値を変更可能**：客単価・規模が違うサロンでも同じ仕組みで運用できる

---

## 2. バッジ定義（PREMIER MODELS デフォルト値）

| バッジ        | 判定条件（年間 LTV）           | 表示                                  | 優先順位 |
| ------------- | ------------------------------ | ------------------------------------- | -------- |
| 🥈 シルバーVIP | **¥30,000 〜 ¥60,000 未満**    | `{ emoji: '🥈', label: 'シルバーVIP' }` | 4        |
| 🥇 ゴールドVIP | **¥60,000 〜 ¥90,000 未満**    | `{ emoji: '🥇', label: 'ゴールドVIP' }` | 3        |
| 💠 プラチナVIP | **¥90,000 以上**               | `{ emoji: '💠', label: 'プラチナVIP' }` | 2        |
| 👑 殿堂入り    | 累計 LTV `hall_of_fame.threshold` 以上（**標準: 無効化**） | `{ emoji: '👑', label: '殿堂入り' }`   | 1（最上位） |

**実分布における該当目安**（n=884, 直近1年で来店あり）:

| バッジ | 該当人数 | サロン全体に占める割合 |
|---|---:|---:|
| 🥈シルバー (¥30K–60K) | 推定 約100人 | 約11% |
| 🥇ゴールド (¥60K–90K) | 推定 約30人 | 約3% |
| 💠プラチナ (≥¥90K) | 推定 約9人 | 約1% |

**表示ルール**:
- 年間 LTV 系（シルバー / ゴールド / プラチナ）は **同時に1つだけ表示**（上位が出る）
- 殿堂入りは別枠で常時併記可能（例: 「👑 殿堂入り ＋ 💠 プラチナVIP」）
- 既存 `computeBadges()` の返却バッジの **先頭**（emoji 枠の最初）に並べる
- **殿堂入りは標準で `hide=true` のため非表示**。サロン設定で有効化されたサロンのみ表示

---

## 3. 判定ロジック（擬似コード）

```js
function computeVipBadges(karteNo, customer, visitsOfCustomer, salonConfig, now = new Date()) {
  const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

  // 集計（除外条件は salonConfig.payment_status_excluded で指定 — 標準は ['未会計']）
  const isExcluded = (v) => salonConfig.payment_status_excluded.includes(v.payment_status);
  const visitsImportedCount = visitsOfCustomer.filter(v => !isExcluded(v)).length;

  // 年間LTV: visits 必須（時系列のため customers から fallback 不可）
  const annualLtv = visitsOfCustomer
    .filter(v => v.start_time >= oneYearAgo && !isExcluded(v))
    .reduce((s, v) => s + (v.treatment_total ?? 0) + (v.retail_total ?? 0), 0);

  // lifetime_ltv: B3 補正対象。visits_imported_count < threshold_high なら customers.total_payment にフォールバック
  let lifetimeLtv;
  let lifetimeSource;
  if (visitsImportedCount >= salonConfig.lv.fallback.threshold_high) {
    lifetimeLtv = visitsOfCustomer
      .filter(v => !isExcluded(v))
      .reduce((s, v) => s + (v.treatment_total ?? 0) + (v.retail_total ?? 0), 0);
    lifetimeSource = 'visits';
  } else {
    lifetimeLtv = customer.total_payment ?? 0;
    lifetimeSource = 'customers.total_payment';
  }

  // reliability: annual_ltv は visits 主軸のため、visits 充足度で決まる
  const reliability =
    visitsImportedCount >= salonConfig.lv.fallback.threshold_high ? 'high'
    : visitsImportedCount >= salonConfig.lv.fallback.threshold_medium ? 'medium'
    : 'low';

  const badges = [];
  const tiers = salonConfig.vip.tiers;   // [{ key, threshold }] を threshold 降順で

  // 年間 LTV 系（最上位を1つだけ）
  for (const t of tiers) {
    if (annualLtv >= t.threshold) {
      badges.push({ emoji: t.emoji, label: t.label, tier: t.key });
      break;
    }
  }

  // 殿堂入り（hide=false のサロンのみ評価 / lifetimeLtv は B3 補正後の値を使用）
  const hof = salonConfig.vip.hall_of_fame;
  if (!hof.hide && lifetimeLtv >= hof.threshold) {
    badges.push({ emoji: '👑', label: '殿堂入り', tier: 'hall_of_fame' });
  }

  return {
    badges,
    annualLtv,
    lifetimeLtvObserved: lifetimeLtv,
    lifetimeSource,                       // 'visits' | 'customers.total_payment'
    reliability,                          // 'high' | 'medium' | 'low'
    annualLtvReliability: visitsImportedCount > 0 ? reliability : 'low',  // annual は常に visits 依存
  };
}
```

**重要な制約**（§ 13 で詳述）:
- `annual_ltv` は時系列必須のため customers からの fallback 不可。`reliability=low` の顧客は VIP 判定が低めに出る（年間 LTV=0 扱いになりやすい）
- `lifetime_ltv_observed` は B3 補正で `customers.total_payment` にフォールバック可能（殿堂入り判定に効く）

---

## 4. 判定時期（運用）

| タイミング            | 実装方法                                                             |
| --------------------- | -------------------------------------------------------------------- |
| 毎月1日 0:00（定期）  | 夜間バッチで全顧客の annual_ltv / lifetime_ltv_observed を再計算し DB に保存 |
| 来店登録時（増分）    | visits UPSERT フックで対象 karte_no のみ即時再計算                  |
| API 呼び出し時        | 保存済みの annual_ltv / lifetime_ltv_observed を読むだけ（軽量）     |

MVP では **毎月1日の夜間バッチ ＋ API 呼び出し時に保存値を返す** のが最もシンプル。
将来、来店登録のフックで増分更新を加える（visits へ INSERT があった場合だけ当該顧客の集計を走らせる）。

---

## 5. 既存 API への追加フィールド案

`GET /character/api/:karte_no` の返却 JSON に以下を追加:

```json
{
  "success": true,
  "customer": { ... 既存フィールド ... },
  "badges": [ ... 既存バッジ（10年クルー等） ... ],
  "vip": {
    "tier": "gold",                  // "silver" | "gold" | "platinum" | null
    "hall_of_fame": false,           // hide=true のサロンでは常に false
    "annual_ltv": 64500,             // 直近365日のLTV（円・税込）
    "lifetime_ltv_observed": 92000,  // 集計可能LTV（visits取込範囲内の累計、または B3 補正時は customers.total_payment）
    "annual_ltv_to_next": 25500,     // 次ランクまでの残額（円、nullなら最高ランク）
    "lifetime_source": "visits",      // 'visits' | 'customers.total_payment'（B3 補正の有無）
    "reliability": "high",            // 'high' | 'medium' | 'low'（lv-v1-spec § 14 と整合）
    "annual_ltv_reliability": "high", // annual は常に visits 主軸のため別フラグ
    "thresholds_used": {              // この顧客の判定に使われた閾値（デバッグ用）
      "silver": 30000,
      "gold": 60000,
      "platinum": 90000
    }
  }
}
```

- `vip.tier` を **カードUIで最上部に表示**
- `annual_ltv_to_next` を使って「あと ¥25,500 でゴールド」のような進捗バーも将来出せる
- `lifetime_ltv` ではなく **`lifetime_ltv_observed`** という名称で返す（取込範囲内の集計値であることを明示。理由は § 11）
- `reliability='low'` の場合、UI 側で `annual_ltv` の横に「※」マーク表示（lv-v1-spec § 13.6 と整合）

---

## 6. DB 追加カラム（推奨）

MVP の集計コストを下げるために customers へキャッシュ列を追加。
**実装前に最終承認を取る**（DDL が必要なため）:

```sql
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS ltv_total_annual            integer,
  ADD COLUMN IF NOT EXISTS ltv_total_lifetime_observed integer,
  ADD COLUMN IF NOT EXISTS vip_tier                    text,
  ADD COLUMN IF NOT EXISTS vip_hall_of_fame            boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS vip_lifetime_source         text,         -- 'visits' | 'customers.total_payment'
  ADD COLUMN IF NOT EXISTS vip_reliability             text,         -- 'high' | 'medium' | 'low'
  ADD COLUMN IF NOT EXISTS vip_updated_at              timestamptz;
```

- `ltv_total_annual` は **毎月1日バッチで更新**（その他日には古い値を返す）
- `ltv_total_lifetime_observed` は B3 補正適用時は `customers.total_payment` の値が入る（`vip_lifetime_source='customers.total_payment'` で識別）
- `vip_tier` は `('silver','gold','platinum')` を想定（CHECK 制約は任意）
- カラム名 `ltv_total_lifetime` は **`ltv_total_lifetime_observed` に変更**（"累計" 誤認回避）
- `vip_reliability` は lv-v1-spec § 14 と同期（同じ visitsImportedCount 判定）

---

## 7. カード表示での位置（character.html）

既存のレイアウト:
- キャラクターカード
  - 動物
  - 名前 + なかよしレベル
  - 16タイプボックス
  - **statRow（じょうたい + 来店回数 + 最終来店 ← ここに並ぶ）**
- ごほうびセクション（reward-grid）

**VIP バッジは `statRow` の一番左**（じょうたいバッジの前）に追加する。
色はバッジ階層ごとに変える:

```css
.badge.vip-silver   { background: #e9eef5; color: #4a5b75; }
.badge.vip-gold     { background: #fff1c2; color: #b0861b; }
.badge.vip-platinum { background: #dff2ef; color: #2a7b74; }
.badge.vip-hof      { background: linear-gradient(135deg, #ffe49a, #ff6f92); color: #fff; }
```

殿堂入りは独立枠として「じゅうみんカード」ヘッダー右端に置くデザインも検討価値あり（常連のご威光を常時見せる）。

---

## 8. Lv との整合性

- Lv 計算の ②LTV（30点）と VIP バッジは **同じ visits データから算出** するが、用途が違う
  - Lv: サロン内相対（店舗規模による絶対額のブレを吸収）
  - VIP: **絶対額**（誰が見ても分かりやすい称号）
- 配下のバッチは **同じ集計結果を共有可能**（annual_ltv / lifetime_ltv_observed を customers に書いておけば両者から参照）

---

## 9. サロン毎の設定可能項目

`docs/salon-config-specification.md` に詳細を記載するが、本仕様書に関わる項目は次の通り:

```js
// salon_config.vip 抜粋（PREMIER MODELS デフォルト）
{
  vip: {
    tiers: [
      { key: 'platinum', label: 'プラチナVIP', emoji: '💠', threshold: 90_000 },
      { key: 'gold',     label: 'ゴールドVIP', emoji: '🥇', threshold: 60_000 },
      { key: 'silver',   label: 'シルバーVIP', emoji: '🥈', threshold: 30_000 },
    ],
    hall_of_fame: {
      hide:      true,           // 標準は非表示
      threshold: 5_000_000,      // 有効化された場合の閾値
      label:     '殿堂入り',
      emoji:     '👑',
    },
    payment_status_excluded: ['未会計'],   // LTV集計から除外する payment_status 値
  },
}
```

サロン追加時は、上記をオーバーライド (DB or 設定ファイル) するだけで運用可能。

---

## 10. MVP 実装範囲

| 項目                        | MVP | Phase 2.5 | Phase 3 |
| --------------------------- | --- | --------- | ------- |
| 3 バッジ判定ロジック         | ✓   |           |         |
| /character/api 返却への追加  | ✓   |           |         |
| character.html 表示（静的）  | ✓   |           |         |
| DB キャッシュ列追加          | ✓   |           |         |
| 毎月1日バッチ                | ✓   |           |         |
| salon_config 参照            | ✓   |           |         |
| 殿堂入り表示（hide=false時） |     | ✓         |         |
| 来店登録フックで増分更新     |     | ✓         |         |
| 「次ランクまで」進捗バー     |     | ✓         |         |
| メール/LINE 到達通知         |     |           | ✓       |

---

## 11. 閾値設定の根拠（過去経緯）

### 11.1 当初案 (2026-04-23)
仮値として ¥150K / ¥300K / ¥600K（年間）+ ¥5M（殿堂入り）を提示。

### 11.2 実データ検証 (2026-04-26)
PREMIER MODELS の visits 3,115件（16ヶ月分）で再検証した結果:

- 年間LTV max = **¥141,100**（1人）→ **シルバー(¥150K) すら誰も到達せず**
- 累計LTV max = **¥175,000**（1人）→ **殿堂入り(¥5M) 完全に非現実的**
- 当初案は **オーダーが1桁ズレていた**

### 11.3 確定案 (2026-04-26)
実分布のパーセンタイルに合わせて再設計:

| バッジ | 旧案 | 新案 | 根拠 |
|---|---:|---:|---|
| シルバー | ¥150K | **¥30K** | p85 相当 |
| ゴールド | ¥300K | **¥60K** | p95 相当 |
| プラチナ | ¥600K | **¥90K** | p99 相当 |
| 殿堂入り | ¥5M | **hide=true** | 到達不能のため標準で無効化 |

新閾値での該当人数（推定）: シルバー約100人 / ゴールド約30人 / プラチナ約9人 → 「希少性」と「該当者の存在」を両立。

---

## 12. 判断が必要な論点（2026-04-27 確定）

| # | 論点 | 確定内容 |
|---|------|----------|
| 1 | 年間 LTV の集計窓 | **直近 365 日で確定**。MVP はこれで運用、Phase 2.5 で年度単位（1〜12月）も検討 |
| 2 | 税抜/税込 | **税込で統一**。Lv v1 仕様書 §12 と揃え、`treatment_total + retail_total` をそのまま税込として扱う |
| 3 | キャンセル扱い | **`'未会計'` のみ除外で確定**。実データに取消/キャンセル値は存在せず、`salon_config.payment_status_excluded = ['未会計']` をデフォルト |
| 4 | シルバー未満の表示 | **無バッジで運用**（「VIP 候補」等の下位バッジは Phase 2.5 で再検討） |
| 5 | 新カラム名 `ltv_total_lifetime_observed` | **`ltv_total_lifetime_observed` で確定**（「観測範囲内の累計」を明示）。旧 `ltv_total_lifetime` を rename |
| 6 | 殿堂入りの標準有効化 | **標準は `hide=true` で確定**。実データ最大 ¥175K に対し ¥5M 閾値は到達不能のため、標準では非表示。サロン毎に `salon_config.vip.hall_of_fame.hide = false` で個別有効化可能 |
| 7 | B3 暫定補正の VIP 適用 | **`lifetime_ltv_observed` は customers.total_payment にフォールバック可。`annual_ltv` は時系列必須のため fallback 不可（2026-04-27 ヒロキ確定 / β案）**。詳細は § 13 |

---

## 13. B3 暫定補正の VIP 判定への影響（2026-04-27 確定）

### 13.1 背景

lv-v1-spec § 13 で導入された B3 暫定補正は、`visits_imported_count < 5` の顧客に対し customers.* で fallback 計算する仕組み。VIP 判定にも以下の対応を入れる:

### 13.2 fallback の適用範囲

| 指標                       | fallback 可否 | fallback 方法                          |
|----------------------------|---------------|----------------------------------------|
| `lifetime_ltv_observed`    | **可**        | `customers.total_payment` を使用      |
| `annual_ltv`（直近365日）  | **不可**      | 時系列必須のため visits からのみ算出  |
| 殿堂入り判定               | **可**        | fallback された `lifetime_ltv_observed` を使用 |
| 年間 VIP 階層判定 (silver/gold/platinum) | **不可** | `annual_ltv` 依存 |

### 13.3 影響を受ける顧客の VIP 判定

`reliability='low'` の顧客は:
- **殿堂入り**: `customers.total_payment` で判定可能 → **正しく判定される**
- **年間 VIP 階層**: 直近 365 日の visits が乏しい → **無バッジ扱いになりやすい**（false negative の可能性）

これは仕様上の制約であり、`vip.annual_ltv_reliability='low'` フラグで UI 側に通知する。

### 13.4 田丸さん(9215) の VIP 判定例

| 項目                  | 値                       | 判定                                |
|-----------------------|--------------------------|--------------------------------------|
| `visits_imported_count` | 1                       | `reliability=low`                    |
| `annual_ltv`           | ¥0（visits<2 のため）   | 年間 VIP 階層なし                   |
| `lifetime_ltv_observed`(B3 fallback) | ¥326,200 (`customers.total_payment`) | 殿堂入り閾値 ¥5M 未満 → 殿堂入りなし（標準では hide=true で非表示） |
| `lifetime_source`      | `customers.total_payment` |                                      |
| `vip.tier`             | null                     | UI に「※ visits 取込が少ないため暫定」を表示 |

過去 visits 追加取込後、田丸さんの annual_ltv が判明すれば再判定される（init-mq-lv-v1.js --recalc 後）。

### 13.5 サロン横展開時の運用

- VIP は「実データに基づく称号」のため、reliability=low 顧客に強引に VIP を付けることはしない
- 過去 visits 取込が完了してから初めて VIP 判定の信頼性が担保される
- 開店初期サロンでは visits 蓄積に時間がかかるため、VIP 判定は数ヶ月運用してから期待値が安定する
