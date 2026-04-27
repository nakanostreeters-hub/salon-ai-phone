# Maikon Quest — サロン設定（salon_config）仕様書

**対象**: Lv 算出 / VIP バッジ / セグメント判定 のすべての**閾値・配点・除外条件・有効化フラグ**を、サロン毎にオーバーライド可能にするための設定機構
**スコープ**: 新規モジュール `services/salonConfig.js`、新規テーブル `salon_configs`、各算出モジュール（`questEngine.js` / `vipBadges.js` / `customerSegment.js`）からの参照
**最終更新**: 2026-04-27（B3 暫定補正パラメータ `lv.fallback.*` を追加）

---

## 1. 設計思想

- **コードは1セット、設定はサロン毎**
  - 算出ロジックは共通実装。サロン毎の差異は設定値だけで吸収する
  - 客単価・規模・客層が違うサロンでも、同じMaikon Questが運用できる
- **未設定ならデフォルト値を使用**
  - 設定の一部だけ上書き可能（深いマージ）
  - 全項目を埋めなくても動作する
- **Phase 2 MVP は PREMIER MODELS のデフォルト値で運用**
  - 設定UIは作らない（DB or 設定ファイルを直接編集）
  - 将来サロン追加時に設定UIを追加する

---

## 2. 設定の階層構造

```
defaults  (services/salonConfig.js 内のハードコード)
   ↓ 深いマージ (lodash.merge 相当)
PREMIER MODELS の上書き  (DB or YAMLファイル)
   ↓
最終 effectiveConfig  (各算出モジュールに渡す)
```

`getSalonConfig(salon_id)` は最終マージ済み config を返す純粋関数。各バッチ・APIはこれを通して設定を取得する。

---

## 3. 設定スキーマ全体

```ts
interface SalonConfig {
  // 共通除外条件
  payment_status_excluded: string[];          // LTV集計から除外する payment_status 値

  // ① Lv 算出
  lv: {
    weights: {
      frequency:  number;   // ① 来店頻度 配点
      ltv:        number;   // ② LTV 配点
      cycle:      number;   // ③ 周期適合度 配点
      tenure:     number;   // ④ 継続年数 配点
      stylist:    number;   // ⑤ スタイリスト継続性 配点
      engagement: number;   // ⑥ エンゲージメント余地 配点
    };
    tenure_max_years:            number;   // tenure 満点に達する年数
    stylist_window:              number;   // 担当継続性の集計対象件数
    engagement_default:          number;   // ⑥ MVP 固定値
    smoothing_alpha:             number;   // 30日スムージングの新値ウェイト (0〜1)
    min_population_for_relative: number;   // 母集団 < これなら絶対閾値フォールバック

    // B3 暫定補正パラメータ（2026-04-27 追加 / lv-v1-spec § 13 と整合）
    fallback: {
      threshold_high:           number;   // visits_imported_count >= これ → reliability='high'（補正なし）
      threshold_medium:         number;   // 2 <= ... < threshold_high → 'medium'（一部補正）
                                          //  < threshold_medium → 'low'（主要補正）
      stylist_ratio_default:    number;   // ⑤ stylist fallback の中立値 (PREMIER: 0.7)
      p_recent_attenuation:     number;   // ① p_recent fallback 係数 (PREMIER: 0.7)
    };
  };

  // ② VIP バッジ
  vip: {
    tiers: Array<{
      key:       'silver' | 'gold' | 'platinum';
      label:     string;
      emoji:     string;
      threshold: number;       // 年間LTV 円
    }>;
    hall_of_fame: {
      hide:      boolean;      // true なら判定スキップ
      threshold: number;       // 累計(observed) LTV 円
      label:     string;
      emoji:     string;
    };
    annual_window_days: number;   // 年間LTV の集計窓 (default: 365)
  };

  // ③ セグメント判定
  segment: {
    ltv_high_percentile:        number;   // PREMIER: 0.5
    ltv_high_absolute_fallback: number;   // 母集団<min時の絶対閾値 (円)
    health_deviation_max:       number;   // 個人周期の何倍超で離脱判定 (PREMIER: 0.5 → 1.5倍)
    min_visits_for_judgment:    number;   // これ未満は watch_over (PREMIER: 2)
    update_frequency:           'daily' | 'weekly';   // 再判定頻度
  };

  // ④ 成長段階 UI (growth-stage-specification.md)
  growth: {
    stage_boundaries: {
      egg:    number;   // mq_lv_score <= これ → 🥚 たまご (PREMIER: 20)
      baby:   number;   // <= これ → 🐣 あかちゃん (PREMIER: 40)
      child:  number;   // <= これ → 🐥 こども (PREMIER: 60)
      adult:  number;   // <= これ → 🦁 おとな (PREMIER: 80)
      // > adult → 👑 マスター
    };
    egg_color_per_animal:        boolean;   // 🥚 を動物別に色分けするか (PREMIER: false)
    evolve_animation:            'chip_rise' | 'confetti' | 'pulse_ring';   // 進化演出方式
    next_evolve_hint_visibility: 'staff_only' | 'public';   // 「次の進化まで」の開示範囲
  };
}
```

---

## 4. PREMIER MODELS デフォルト値

```js
// services/salonConfig.js
const PREMIER_MODELS_CONFIG = {
  payment_status_excluded: ['未会計'],

  lv: {
    weights: {
      frequency:  25,
      ltv:        30,
      cycle:      20,
      tenure:     10,
      stylist:    10,
      engagement:  5,
    },
    tenure_max_years:            10,
    stylist_window:              10,
    engagement_default:          2.5,
    smoothing_alpha:             0.3,        // Phase 2.5 まで未使用
    min_population_for_relative: 50,

    // B3 暫定補正（2026-04-27 追加）
    fallback: {
      threshold_high:           5,            // visits_imported_count >= 5 → reliability='high'
      threshold_medium:         2,            // 2〜4 → 'medium', <2 → 'low'
      stylist_ratio_default:    0.7,          // ⑤ stylist fallback の中立値
      p_recent_attenuation:     0.7,          // ① p_recent の last_visit_at ≤ 365d 時の係数
    },
  },

  vip: {
    tiers: [
      { key: 'platinum', label: 'プラチナVIP', emoji: '💠', threshold: 90_000 },
      { key: 'gold',     label: 'ゴールドVIP', emoji: '🥇', threshold: 60_000 },
      { key: 'silver',   label: 'シルバーVIP', emoji: '🥈', threshold: 30_000 },
    ],
    hall_of_fame: {
      hide:      true,            // PREMIER MODELS は標準で無効化
      threshold: 5_000_000,
      label:     '殿堂入り',
      emoji:     '👑',
    },
    annual_window_days: 365,
  },

  segment: {
    ltv_high_percentile:        0.5,
    ltv_high_absolute_fallback: 50_000,
    health_deviation_max:       0.5,
    min_visits_for_judgment:    2,
    update_frequency:           'daily',
  },

  growth: {
    stage_boundaries: {
      egg:    20,
      baby:   40,
      child:  60,
      adult:  80,
    },
    egg_color_per_animal:        false,         // MVP は共通色（ミントグリーン）
    evolve_animation:            'chip_rise',   // 段階チップが下から競り上がる演出
    next_evolve_hint_visibility: 'staff_only',  // スタッフ向けカードのみ
  },
};
```

### 4.1 デフォルト値の根拠

| 項目                          | 値        | 根拠                                                |
|-------------------------------|-----------|-----------------------------------------------------|
| Lv 配点 (25/30/20/10/10/5)    | 6項目計100| 当初設計、運用後に再評価                            |
| VIP シルバー閾値              | ¥30,000   | 実分布 p85 (年間LTV)                                |
| VIP ゴールド閾値              | ¥60,000   | 実分布 p95                                          |
| VIP プラチナ閾値              | ¥90,000   | 実分布 p99                                          |
| 殿堂入り hide=true            | 無効      | 累計LTV max=¥175,000 のため到達者ゼロ。設定として残すが標準無効 |
| 殿堂入り閾値 ¥5M              | (参考値)  | 旧仕様の値を保持。サロンが有効化する場合の目安      |
| LTV高低 50% パーセンタイル    | 0.5       | サロン内の上位/下位を半々で分ける素朴な閾値         |
| 健全性 deviation 0.5          | 1.5倍     | 個人周期の1.5倍超えを離脱判定                       |
| min_visits 2                  | 2         | 個人周期算出に最低2件 (interval=1) 必要             |
| payment_status_excluded       | `['未会計']` | 実データで取消値は存在せず、未会計のみ確認        |
| 成長段階境界 (20/40/60/80)    | 等幅      | Lv 式 `ceil(score/5)` と完全整合（4 Lv ごと 1 段階上昇） |
| evolve_animation = chip_rise  | (c)案     | 既存 CSS だけで実装可、スタッフ手元タブレット運用に整合 |
| egg_color_per_animal = false  | 共通色    | MVP は実装最小・ガチャ感重視。Phase 2.5 で動物別検討 |
| next_evolve_hint = staff_only | 内部のみ  | 顧客向けスコア開示は文化的抵抗もあり別途意思決定    |
| **fallback.threshold_high = 5** | high閾値 | cycle 計算には最低 4 intervals = 5 visits 必要      |
| **fallback.threshold_medium = 2** | medium閾値 | individual cycle算出に最低 1 interval = 2 visits |
| **fallback.stylist_ratio_default = 0.7** | 中立値 | 担当記録ありなら高めの継続性を仮定（厳しすぎない） |
| **fallback.p_recent_attenuation = 0.7** | 控えめ係数 | last_visit_at が直近365日以内ある = 「ある程度来てる」想定 |

---

## 5. DB 設計案

### 5.1 推奨案: 専用テーブル `salon_configs`

```sql
CREATE TABLE IF NOT EXISTS public.salon_configs (
  salon_id    text PRIMARY KEY,        -- 'premier-models' 等
  config      jsonb NOT NULL,          -- 上書き分のみ保存（部分マージ）
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text                     -- 任意（誰が更新したか）
);
```

- `config` には**デフォルトとの差分だけ**を保存（深いマージ）
- 取得時はコード内デフォルトと深いマージしてから使用
- 例: PREMIER MODELS が殿堂入りを有効化する場合、`config = { vip: { hall_of_fame: { hide: false } } }` だけ保存

### 5.2 代替案: 設定ファイル `config/salon-overrides.json`

```json
{
  "premier-models": {
    "vip": { "hall_of_fame": { "hide": false } }
  }
}
```

- 利点: DB DDL 不要、Git 管理可能
- 欠点: サロン追加・変更でデプロイが必要

### 5.3 採用方針

**MVP は B案（設定ファイル）でスタートを推奨**:
- PREMIER MODELS 1サロンのみなのでDB化のメリットが薄い
- 将来サロンが増えてからA案に移行

→ **どちらを採用するか、ヒロキさんの判断待ち**（§ 8 論点1）

---

## 6. 取得ロジック（擬似コード）

```js
// services/salonConfig.js

const DEFAULT_CONFIG = { /* ... PREMIER MODELS と同じ構造の素のデフォルト ... */ };
const PREMIER_MODELS_CONFIG = { /* § 4 のオブジェクト */ };

const HARDCODED_OVERRIDES = {
  'premier-models': PREMIER_MODELS_CONFIG,
};

async function getSalonConfig(salonId) {
  // (A案) DB から取得
  // const { data } = await sb.from('salon_configs').select('config').eq('salon_id', salonId).maybeSingle();
  // const dbOverride = data?.config ?? {};

  // (B案) ハードコード or JSONファイル
  const fileOverride = HARDCODED_OVERRIDES[salonId] ?? {};

  return deepMerge(DEFAULT_CONFIG, fileOverride);
}

function deepMerge(target, source) {
  // 配列は置き換え、オブジェクトは再帰マージ（lodash.merge 相当）
  // 詳細実装は別途
}
```

各算出モジュールの最初でこれを呼び、戻り値を渡す:

```js
// scripts/init-mq-levels.js
const config = await getSalonConfig('premier-models');
const lvScore = calcLvScore(customer, context, config);
```

---

## 7. オーバーライド例

### 例1: VIP閾値だけを変える別サロン

```json
{
  "salon_id": "salon-a",
  "config": {
    "vip": {
      "tiers": [
        { "key": "platinum", "label": "プラチナVIP", "emoji": "💠", "threshold": 200000 },
        { "key": "gold",     "label": "ゴールドVIP", "emoji": "🥇", "threshold": 120000 },
        { "key": "silver",   "label": "シルバーVIP", "emoji": "🥈", "threshold": 60000 }
      ]
    }
  }
}
```

→ Lv・セグメント設定はデフォルトのまま、VIP閾値だけ高単価サロン向けに変更

### 例2: 殿堂入りを有効化

```json
{
  "salon_id": "salon-b",
  "config": {
    "vip": { "hall_of_fame": { "hide": false, "threshold": 1500000 } }
  }
}
```

### 例3: セグメント判定をより厳しくする

```json
{
  "salon_id": "salon-c",
  "config": {
    "segment": { "health_deviation_max": 0.3, "ltv_high_percentile": 0.7 }
  }
}
```

→ 個人周期の1.3倍超えで離脱判定 + 上位30%を高LTV扱い

---

## 8. 判断が必要な論点

1. **DB 採用 (A案) か 設定ファイル (B案) か?**
   - MVP は B案推奨。サロン追加時にA案へ移行
   - **ヒロキさんの判断待ち**

2. **設定変更時の即時反映 vs 次回バッチで反映**:
   - 即時反映: 設定変更 → 全顧客の Lv/VIP/セグメント を再計算（重い）
   - 次回バッチ: 翌日まで反映を待つ（軽い、運用上は十分）
   - 推奨: **次回バッチで反映**

3. **設定の変更履歴**:
   - サロン側で「いつ閾値を変えたか」を追跡できると便利
   - DB案ならカラム `previous_config jsonb` を増やせばよい
   - MVP では履歴なし、Phase 2.5 で追加検討

4. **設定 UI の提供**:
   - MVP ではコード/ファイル直接編集
   - 将来は管理画面（mycon管理）から編集可能にする予定？

5. **テナント分離**:
   - `salon_id` は customers/visits にも入っているため、データ分離は既に可能
   - 設定だけ追加しても、データ分離の追加対応は不要

---

## 9. MVP 実装範囲

| 項目                                    | MVP | Phase 2.5 | Phase 3 |
| --------------------------------------- | --- | --------- | ------- |
| `services/salonConfig.js` (取得関数)    | ✓   |           |         |
| デフォルト値ハードコード                | ✓   |           |         |
| PREMIER MODELS 上書き                   | ✓   |           |         |
| 各算出モジュールへの config 引数追加    | ✓   |           |         |
| DB テーブル `salon_configs`             | (A案採用時) | ✓ |         |
| 設定変更履歴                            |     | ✓         |         |
| 管理画面 UI                             |     |           | ✓       |

---

## 10. 既存コードへの影響

| ファイル                          | 変更内容                                                  |
| --------------------------------- | --------------------------------------------------------- |
| `services/salonConfig.js`         | **新規作成**                                              |
| `services/questEngine.js`         | `calcLvScore(customer, ctx, config)` シグネチャ変更       |
| `services/customerSegment.js`     | **新規作成**: `determineSegment(customer, visits, config, allLtv)` |
| `services/vipBadges.js`           | **新規作成**: `computeVipBadges(karteNo, visits, config)` |
| `scripts/init-mq-levels.js`       | バッチ冒頭で `getSalonConfig('premier-models')` を呼ぶ    |
| `routes/character.js`             | `/character/api/:karte_no` で `getSalonConfig` を呼び、各サービスに渡す |
| `public/character.html`           | `stageOf(score)` 内の境界値を `config.growth.stage_boundaries` から受け取る（API レスポンスに含めて渡す）|
| `scripts/migrate-mq-schema.sql`   | A案採用時のみ `salon_configs` テーブル追加                |

---

## 11. テスト方針

- ユニットテスト:
  - `deepMerge` の挙動（配列置き換え / オブジェクト再帰）
  - `getSalonConfig('premier-models')` が § 4 の値と完全一致
  - 未登録 salon_id でデフォルト値が返る
- 結合テスト:
  - `calcLvScore` を 同じ顧客・異なる config で呼び、配点変更が反映されることを確認
  - VIP バッジが閾値変更で正しく切り替わる

---

## 12. 移行・互換性

- 既存の `customer_segment` カラムは触らない（Lv/VIP/segment_v2 は独立運用）
- 既存の `mq_level` / `mq_experience` の扱いは Lv v1 仕様書 § 8 を参照
- VIP 関連カラム (§ VIP仕様書 § 6) は新規追加
- segment_v2 関連カラム (§ セグメント仕様書 § 8) は新規追加
- 成長段階関連カラム `mq_lv_score` / `mq_lv_breakdown` / `mq_last_stage_up_at` は Lv v1 仕様書 § 8 と growth-stage 仕様書 § 7-5 で追加
- **DB DDL の実行は最終承認後**

---

## 13. 参照仕様書

| 仕様書 | 役割 | 本仕様との関係 |
|--------|------|---------------|
| `docs/lv-v1-specification.md` | mq_lv_score 算出ロジック | 本仕様の `lv` セクションが配点・式パラメータを供給 |
| `docs/vip-badges-specification.md` | LTV ベース VIP 称号 | 本仕様の `vip` セクションが閾値を供給 |
| `docs/customer-segmentation-specification.md` | 5 セグメント判定 | 本仕様の `segment` セクションがパーセンタイル・健全性閾値を供給 |
| `docs/growth-stage-specification.md` | 5 段階成長 UI | 本仕様の `growth` セクションが段階境界・演出方式を供給 |
