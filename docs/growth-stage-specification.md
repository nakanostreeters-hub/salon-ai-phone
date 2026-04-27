# Maikon Quest — 成長段階 (Growth Stage) UI 仕様書

**対象**: お客様キャラクターの "5段階成長表現" を `public/character.html` に組み込むための設計
**前提**: `docs/lv-v1-specification.md` に定義された `mq_lv_score` (0–100) が導出済みである
**スコープ**: UI 表現の設計のみ。Lv 算出ロジックそのものは Lv v1 仕様の責務
**最終更新**: 2026-04-27（B3 暫定補正の reliability='low' 時の※マーク表示を追記）

---

## 0. 概要

お客様の "なかよし度" を 5 段階の動物の成長アイコンとして可視化する。

| 段階 | 絵文字 | 名前 | mq_lv_score |
| ---- | ------ | ---------- | -------------- |
| 1    | 🥚     | たまご     | 0 – 20         |
| 2    | 🐣     | あかちゃん | 21 – 40        |
| 3    | 🐥     | こども     | 41 – 60        |
| 4    | 🦁     | おとな     | 61 – 80        |
| 5    | 👑     | マスター   | 81 – 100       |

`mq_lv_score` は Lv v1 仕様で定義される 0–100 の浮動小数。本 UI 仕様は「`mq_lv_score` を見て 5 段階のどれを描画するか」と「カード上のどこに見せるか」だけを定義する。

---

## 1. 成長段階の判定ロジック

### 1-1. 段階の判定式

```
function stageOf(score) {
  if (score == null)        return 'unknown';   // mq_lv_score 未計算
  if (score <= 20)          return 'egg';       // 🥚 たまご
  if (score <= 40)          return 'baby';      // 🐣 あかちゃん
  if (score <= 60)          return 'child';     // 🐥 こども
  if (score <= 80)          return 'adult';     // 🦁 おとな
  return 'master';                              // 👑 マスター
}
```

- 上限を含む半開区間 `(prev, curr]` 形式で固定。score=20.0 はちょうど 🥚、score=20.01 から 🐣。
- score=null は **判定保留**（後述、Lv v1 バッチ未適用顧客の扱い）。

### 1-2. 境界値の根拠

a. **20点等幅 5 分割** という単純さを優先
  - 段階数=5 は記憶しやすく、ユーザー（サロンスタッフ）への説明コストが最小
  - 等幅であれば、後から `mq_lv_score` の式が変わっても境界の意味は保たれる（"上位5分の1" など可変境界は説明が崩れる）
b. **マスターを 81–100 と狭めにしない**
  - Lv v1 仕様 §9 の試算では、田丸さんクラス（visit パーセンタイル 99.4%）でも score ≒ 75.1 で 🦁 おとな 止まり
  - これは仕様上の合理性: ⑥エンゲージメント余地が固定 2.5 点なので **MVP 期では誰も 100 点に到達しない**（理論上限 ≒ 97.5）
  - 結果として 👑マスター は「全指標が揃った真の上位顧客」を表す稀少枠になり、ありがたみが演出できる
c. **🥚 たまご (0–20) を最広に取らない**
  - Lv v1 §3①で `freq_score = 25 × (0.5×p_total + 0.5×p_recent)` のため、来店 1–2 回でも下位帯のパーセンタイルが多少加算される。0–20 は「ほぼ初回・接点最少」を意味する真にニッチな帯
  - スタッフ側にも「🥚 = 関係性ゼロからのスタート」が直感的

### 1-3. サロン内パーセンタイルとの関係

`mq_lv_score` は Lv v1 仕様により **6 指標の加重和**（うち①②が percentile 由来）。実際の母集団分布は線形ではなく、中央寄りに山ができる想定。

実分布の確認は **Lv v1 バッチ初回投入後** に必須:

| 段階 | 想定占有率 | 確認すべき注意点 |
| ---- | --------- | ---------------- |
| 🥚 たまご     | 25–35% | 来店 0–1 回の幽霊カルテで膨らむ可能性。CSV 由来の "てすと" 等を除外して再集計 |
| 🐣 あかちゃん | 20–30% | リピーター化途上。スタッフが手厚くフォローすべき帯 |
| 🐥 こども     | 20–25% | 月1〜隔月の中堅。中央値付近の最大ボリューム想定 |
| 🦁 おとな     | 10–15% | 確立したリピーター。今回設計のサンプル田丸さんがここ |
| 👑 マスター   | 1–5%   | 枯渇していたら境界を 78 や 75 に下げる検討 |

**運用ルール**: 初回バッチ後の分布が 👑 0% / 🥚 80% など極端に偏る場合は、本仕様 §1-1 の境界値を見直す（§10 §論点1）。

---

## 2. 動物 SVG のバリエーション設計

### 2-1. 全体方針

a. **🥚 たまご段階は全動物共通の "1種の卵" を MVP では採用**
  - 理由 1: 8動物 × 5段階 = 40 SVG はメンテ負荷が大きい。たまご共通化で 8 SVG 削減
  - 理由 2: 「これから何の動物に育つかワクワクする」演出として共通卵に意味がある
  - 理由 3: 🥚 帯は来店 1 回前後で `mq_animal` 判定の信頼度自体が低い（current `determineAnimal()` は visit_count 依存で、卵帯は判定根拠が薄い）
  - **任意拡張**: たまごの色だけ動物別に微差（cat=ピンク・dog=ベージュ・rabbit=白・sheep=クリーム）。実装は SVG の `<circle fill="...">` 1 箇所書き換えのみで容易
b. **🐣 あかちゃん〜👑 マスターは動物別に SVG 5 段階**
  - 既存 8 種（cat / rabbit / dog / sheep / squirrel / panda / bear / fox）すべてに 4 段階分を用意
  - ただし MVP は **DB 実在の 3 種のみ**先行（dog 7,285 / sheep 4,202 / rabbit 60）。残り 5 種は Phase 2.5 以降

### 2-2. 段階別の表現方針

各段階の "らしさ" を一定のルールで表現する（実装の手戻りを減らすため、全動物共通のテンプレ）:

| 段階 | 大きさ | 表情 | 装飾 | アクセント色 |
| ---- | ------ | ---- | ---- | ------------ |
| 🥚 たまご     | 卵殻 viewBox 100% | (顔なし) | ヒビ・葉っぱ・キラキラ ✨ ×1 | サロンのミントグリーン |
| 🐣 あかちゃん | やや小さめ (約85%) | 眼を閉じ気味、ほっぺピンク濃いめ | 卵殻のかけらが頭にちょこんと載る | ベビーピンク |
| 🐥 こども     | 既存 SVG そのもの | デフォルト表情 | 装飾なし | 既存色 |
| 🦁 おとな     | 既存 + 安定感増 | 目元はっきり、口角少し上向き | 葉っぱ or 小さなリボン × 1 | サロンのレモンイエロー |
| 👑 マスター   | 既存 + 凛とした立ち姿 | 落ち着いた笑顔、目に光点 ✨ | 王冠 👑 + キラキラ ✨×3 | ゴールド (#d9a23a) |

**設計原則**:

- **既存 SVG (= 🐥 こども)** をベースラインに置き、段階別の "差分レイヤー" を `<g>` で被せる構造とする
- 例: `🦁 おとな = <use href="#dog-base"/> + <g class="adult-decor">...</g>`
- これにより新動物追加時、各動物のベース SVG 1つ＋装飾レイヤー（全動物共通）4つで済む

### 2-3. 既存 SVG への加工ポイント

`public/character.html` 内の `ANIMAL_SVG` 定数（line 498〜597 付近、現状 `cat/rabbit/dog/sheep/squirrel/panda/bear/fox` の 8 種）を **🐥 こどもの SVG として温存**。新規追加するのは:

```js
const ANIMAL_STAGE_SVG = {
  // 全動物共通の卵 (色だけ動物別に分岐したい場合は egg_cat 等へ拡張)
  egg: `<svg ...>`,

  baby: {
    cat:    `<svg ...>`,  // 既存catを縮小+目を閉じ+卵殻オン
    rabbit: `<svg ...>`,
    // ...
  },
  adult: {
    cat:    `<svg ...>`,
    // ...
  },
  master: {
    cat:    `<svg ...>`,
    // ...
  },
};
// child は既存 ANIMAL_SVG を流用
```

### 2-4. 実装難易度の見積り

| 段階 | 既存 SVG からの加工方針 | 1動物あたり工数 (目安) |
| ---- | ----------------------- | ---------------------- |
| 🥚 たまご     | 完全新規 1 種を作成（共通） | 30 分 (8動物で再利用) |
| 🐣 あかちゃん | 既存 SVG を viewBox 内縮小 + 目線変更 | 15 分 |
| 🐥 こども     | 既存 SVG をそのまま | 0 分 |
| 🦁 おとな     | 既存 SVG + 装飾レイヤー追加 | 20 分 |
| 👑 マスター   | 既存 SVG + 王冠 + キラキラ | 25 分 |

**MVP (3 動物 × 5段階)**: 3×60 + 30(卵共通) ≒ **3.5 時間 で完了見込み**

Phase 2.5 で全 8 動物に拡張する場合: 5×60 + 0 ≒ **5 時間追加**（卵は MVP 時に 1 種作成済み）

---

## 3. UI 上の表示設計

### 3-1. 配置

`.char-card` セクション内の既存配置に **段階バッジ** と **次の進化までの進捗** を割り込ませる:

```
┌─────────────── .char-card ───────────────┐
│                                          │
│        [.animal-circle]      ← 中の SVG が段階別に切替わる
│                                          │
│        [stage-chip 🦁 おとな] ← NEW: 円のすぐ下に追加
│                                          │
│        田丸 弘美   ひつじ                 │
│        ♥ 15 なかよしレベル                │
│                                          │
│        [next-evolve hint]    ← NEW: ハートの下に薄字
│        次の進化まで あと 5.9 点           │
│        (👑 マスターまで)                  │
│                                          │
│        [16タイプ枠 .mbti-box]             │
│        [.stat-row badge群]                │
└──────────────────────────────────────────┘
```

### 3-2. 段階チップ (.stage-chip)

```css
.stage-chip {
  display: inline-flex;
  gap: 6px;
  margin-top: 6px;
  padding: 4px 14px;
  border-radius: 999px;
  background: linear-gradient(135deg, var(--lemon) 0%, var(--lemon-deep) 100%);
  color: #fff;
  font-size: 13px;
  font-weight: bold;
  box-shadow: 0 2px 0 rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.6);
}
.stage-chip.stage-egg    { background: linear-gradient(135deg, #d6f4df 0%, #4ca97a 100%); }
.stage-chip.stage-baby   { background: linear-gradient(135deg, #ffe0ec 0%, #ff6f92 100%); }
.stage-chip.stage-child  { background: linear-gradient(135deg, #fff3cf 0%, #d9a23a 100%); }
.stage-chip.stage-adult  { background: linear-gradient(135deg, #ffd9e6 0%, #c03265 100%); }
.stage-chip.stage-master { background: linear-gradient(135deg, #f9e6a3 0%, #d9a23a 100%);
                           box-shadow: 0 2px 0 #b08316, 0 0 12px #ffd97266; }
```

色は `:root` の既存パレット（pink / lemon / mint / pink-deep 等）から拾い、新色追加は最小限。

### 3-3. 「次の進化まで」表示の文言

```
function renderNextEvolveHint(score, stage) {
  if (stage === 'master')  return '🎉 マスターに到達しています';
  if (stage === 'unknown') return '進化情報は次回ご来店時に解放されます';
  const next = NEXT_BOUND[stage];   // egg→21, baby→41, child→61, adult→81
  const remaining = (next - score).toFixed(1);
  const nextLabel = STAGE_LABEL[NEXT_STAGE[stage]];   // 🐣 あかちゃん など
  return `次の進化まで あと ${remaining} 点（${nextLabel} まで）`;
}
```

### 3-3.1. reliability='low' 時の「※」マーク表示（2026-04-27 追加）

`mq_lv_reliability='low'` または `mq_lv_score_source='visit_count_fallback'` の顧客は、Lv / score 表示に **※** マークを付与する（lv-v1-spec § 13.6 と整合）。

```html
<!-- 通常表示 -->
<div class="mq-level">♥ 12 なかよしレベル</div>

<!-- 暫定値表示（※付き） -->
<div class="mq-level">
  ♥ 12 なかよしレベル
  <span class="reliability-mark" title="visits 取込が少ないため暫定スコアです（過去 visits 取込後に正確な値に更新されます）">※</span>
</div>
```

```css
.reliability-mark {
  display: inline-block;
  margin-left: 4px;
  font-size: 13px;
  color: #b08316;
  cursor: help;
}
.reliability-mark:hover {
  color: #d9a23a;
}
```

**ツールチップ文言**:
- スタッフ向け（mycon管理画面・キャラカード）: 「visits 取込が少ないため暫定スコアです（過去 visits 取込後に正確な値に更新されます）」
- お客様向け（顧客直接表示時）: ※は表示しない（運用ノイズ回避）

**判定ロジック（フロント側）**:
```js
function shouldShowReliabilityMark(customer) {
  return customer.mq_lv_reliability === 'low'
      || customer.mq_lv_score_source === 'visit_count_fallback';
}
```

`reliability='medium'` の顧客には ※ を **表示しない**（運用ノイズ抑制 / lv-v1-spec § 14.1 と整合）。

文言は「あと N 点」を主表記とし、副次に「次は何になるか」を見せる。"X 回来店で進化" 表記は **避ける**:

- `mq_lv_score` は 6 指標の合成のため、来店だけが進化要因ではない（LTV / 周期 / 担当継続性も寄与）
- 「あと X 回」と書くと約束に近い文言になり、実装と乖離した時のクレーム源になりやすい

ただしスタッフ向け管理画面では将来「来店 1 回でおおよそ +N 点」の概算を別途出してもよい（仕様外）。

### 3-4. 進化したときの演出 (Phase 2.3 で実装)

判定: API レスポンスで `customer.mq_last_stage_up_at` が **直近 7 日以内** なら "ばーん" 演出を 1 回再生する（クライアント localStorage で再生済みフラグを管理）。

**演出方式: (c) 段階チップが下から競り上がる で確定 (2026-04-26)**

- 控えめだが既存 CSS だけで実装可能、スタッフ手元タブレット中心の運用に整合
- 紙吹雪 (a) や波紋 (b) はサロン店内ディスプレイ展開時の検討材料として記録のみ残す

```css
@keyframes stageChipRiseUp {
  0%   { transform: translateY(20px); opacity: 0; }
  60%  { transform: translateY(-4px); opacity: 1; }
  100% { transform: translateY(0); opacity: 1; }
}
.stage-chip.stage-just-evolved {
  animation: stageChipRiseUp 0.6s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
```

---

## 4. 既存のキャラカードへの影響

### 4-1. `public/character.html` の変更箇所

| 場所 | 変更内容 | 行数規模 (見積り) |
| ---- | -------- | ---------------- |
| `<style>` 内 | `.stage-chip`, `.next-evolve-hint`, 段階別グラデの追記 | +30 行 |
| `ANIMAL_SVG` 定数 | コメント追記のみ（"= child stage" の意味付け） | +2 行 |
| 新規 `ANIMAL_STAGE_SVG` 定数 | 5 段階 × 3 動物の SVG 定義 | +200 行（SVG 文字列含む） |
| `STAGE_META` 定数 | label / next bound / next stage の対応表 | +20 行 |
| `renderCard()` 内 | (1) animal SVG の選択を `mq_lv_score → stage → ANIMAL_STAGE_SVG[stage][animal]` に変更<br>(2) `.stage-chip` の DOM 生成<br>(3) `.next-evolve-hint` の DOM 生成 | +25 行 |
| `<div id="animalSvg">` 直下 | `<div id="stageChip"></div>` `<div id="nextEvolveHint"></div>` を追加 | +2 行 |

**影響は character.html 単一ファイル内に閉じる**。ルーター (`routes/character.js`) は `mq_lv_score` を返すよう Lv v1 仕様で更新される前提なので、本 UI 仕様では追加の API 変更は不要。

### 4-2. 既存表示要素との棲み分け

| 既存要素 | 役割 | 成長段階との関係 |
| -------- | ---- | -------------- |
| **なかよしレベル (mq_level 1〜20)** | 数値での親密度 | 同じ `mq_lv_score` を別表現で見せる兄弟関係。整合: `Lv 1–4=🥚, 5–8=🐣, 9–12=🐥, 13–16=🦁, 17–20=👑`（境界が score の 20%/40%/... と完全一致）|
| **じょうたい (NEW/げんき/おやすみ/とびっきり)** | 直近の "今" の調子 | **直交する**軸。"おとなだけど今おやすみ中" は普通。両方表示する |
| **バッジ (🏅10年クルー / 👑100回 等)** | 累積実績の達成証 | **直交する**軸。マスター段階でも「100回未満ならまだ 👑バッジは付かない」。両立する |
| **動物の種類 (sheep/dog/...)** | 性格タイプ | 直交する軸。動物 × 5段階のマトリクスでアバター決定 |
| **16タイプ (INFJ/ENFP/...)** | 接客テンプレ用 | 完全に別軸。表示位置も既存の `.mbti-box` のまま |
| **ご無沙汰バッジ (.away-badge)** | 長期来店なし警告 | 直交。ただし "👑 マスター + ご無沙汰 1 年" 等は重大シグナルなので、UI 上は両方目立たせる |

### 4-3. 後方互換性の保証

a. **`mq_lv_score` が null の顧客** (Lv v1 バッチ未適用)
  - `stage = 'unknown'` として扱い、段階チップは **非表示**、`.animal-circle` は既存 `ANIMAL_SVG[mq_animal]` を従来どおり描画
  - 「次の進化まで」は §3-3 の `unknown` 文言を出す
  - つまり Lv v1 投入前後でも、カードは "壊れず" 既存の見た目で動く
b. **`mq_animal` が `ANIMAL_STAGE_SVG` 未対応の動物** (例: MVP 時の cat / squirrel / panda / bear / fox)
  - 段階別 SVG が未定義なら、その動物の "🐥 こども (= 既存 SVG)" にフォールバック
  - 段階チップは正しく表示されるので、見た目は「動物の中身は変わらないが、段階チップで進化が見える」状態になる
c. **API レスポンスにフィールドが無い場合**
  - フロントは `c.mq_lv_score` と `c.mq_last_stage_up_at` を `undefined` 安全に扱う（`?.` チェーン）
  - 型: `mq_lv_score?: number; mq_last_stage_up_at?: string`

---

## 5. 実装フェーズ分け

### Phase 2.1 — 静的SVG ＆ 段階表示（必須）

- ANIMAL_STAGE_SVG (5 × 3 動物) の SVG 文字列追加
- `stageOf(score)` ロジック実装
- `.stage-chip` の DOM レンダリング
- `.animal-circle` の SVG 切り替え
- 後方互換: `mq_lv_score == null` 時の従来挙動を保つ

**完了基準**: 任意の karte_no を `/character/:karte_no` で開いたとき、`mq_lv_score` の値に応じてアバターが 5 段階のいずれかで描画される。

### Phase 2.2 — 進化までのカウント表示

- `STAGE_META`（next_bound / next_stage / label）定数
- `renderNextEvolveHint()` の実装
- `.next-evolve-hint` の DOM レンダリング

**完了基準**: 段階チップの下に「次の進化まで あと X.X 点（🦁 おとな まで）」が表示される。マスター時は祝福文言、unknown 時は保留文言。

### Phase 2.3 — 進化演出（後回し可）

- 演出方式の確定（§3-4 a/b/c から選択）
- `mq_last_stage_up_at` の DB カラム追加 (Lv v1 バッチが書き込む)
- localStorage の再生済みフラグ管理
- アニメーション実装

**完了基準**: 段階が上がった直後の初回カード表示で 1 回だけ演出が再生され、2 回目以降は再生されない。

### 工数の目安

| Phase | 期待工数 |
| ----- | -------- |
| 2.1   | 半日 (SVG 5×3 制作 + ロジック組込) |
| 2.2   | 1〜2 時間 |
| 2.3   | 半日〜1日 (演出方式による) |

---

## 6. 田丸さん (karte_no=9215) を例にしたシミュレーション

### 6-1. 想定 mq_lv_score（B3 暫定補正適用後 / 2026-04-27 確定）

`docs/lv-v1-specification.md` §11.3 の B3 補正適用後のシミュレーション結果。

| 項目 | 値 |
| ---- | -- |
| visit_count | 48 |
| mq_level (旧式) | 6 |
| mq_experience (旧式) | 2,743 |
| mq_animal | sheep |
| mq_state | おやすみ |
| visits_imported_count | 1（< 2 → reliability='low'） |
| **想定 mq_lv_score (Lv v1 / B3 補正後)** | **57.30** |
| **想定 Lv (新式 `ceil(score/5)`)** | **Lv.12** |
| **mq_lv_reliability** | **low** |
| **mq_lv_score_source** | **visit_count_fallback** |
| **UI ※ マーク** | **表示する** |

### 6-2. 段階判定

```
stageOf(57.30) → 'child'       // 41–60 帯
NEXT_BOUND['child']  = 61
NEXT_STAGE['child']  = 'adult'
remaining = 61 - 57.30 = 3.7 点
```

田丸さんは **🐥 こども**。あと 3.7 点で 🦁 おとなに進化する位置（暫定値、※マーク表示）。

### 6-3. カード上の見え方（B3 補正後 / 2026-04-27 確定）

```
┌─────── じゅうみんカード #9215 ───────┐
│                                       │
│         [🐑 ひつじ・こどもSVG]          │  ← 既存 sheep SVG（child = 既存そのまま）
│         [🐥 こども chip]               │  ← 段階チップ
│                                       │
│         田丸 弘美   ひつじ              │
│         ♥ 12 なかよしレベル ※          │  ← ※マーク（reliability=low）
│                                       │
│         次の進化まで あと 3.7 点       │  ← next-evolve-hint
│         (🦁 おとな まで)               │
│                                       │
│         [INFJ — 静かな賢者]            │  ← 既存 mbti-box
│                                       │
│         💡 スタッフへのひとこと          │  ← strategy card (nurture_gold)
│         🔔 ご無沙汰、個別にお声がけを    │
│         LTV 上位なのに周期が崩れています…│
│                                       │
│         [おやすみ] [来店 48回]         │  ← 既存 stat-row
│         [最終 2025年1月9日]            │
│                                       │
│         こんなひと: ...                │  ← 既存 INFJ テンプレ
│         おもてなしのヒント: ...         │
│                                       │
│         ごほうび: 🎖️5年クルー 💎48回   │  ← 既存バッジ群
│                                       │
└───────────────────────────────────────┘
```

**読み解き例（スタッフ向け）**:

- 🐥 こども + おやすみ + INFJ + 💎 育てる金脈 → 「LTV 上位の長期顧客が長期離脱中、個別フォローが最優先」
- ※マーク → 「visits 取込が少ないため暫定スコアです」（過去 visits 取込後に正確な Lv に更新される予告）
- 5年クルー + 48回達成バッジ → 100 回達成までは半分。👑バッジは未獲得
- 「あと 3.7 点で 🦁 おとな」は暫定値（※付き）。過去 visits が取込まれれば再計算される
- → 接客戦略: ご無沙汰フォロー LINE を INFJ テンプレで送り、個別の特別感ある提案で復活を図る

---

## 7. 判断が必要な論点（2026-04-26 確定）

| # | 論点 | 確定内容 |
|---|------|----------|
| 1 | 🥚 たまごの色を動物別に分けるか | **MVP は共通色（ミントグリーン）で確定**。Phase 2.5 で動物別微差を検討 |
| 2 | 段階境界値を等幅 (0/20/40/60/80) 固定か分位ベース調整か | **等幅固定で確定**。`docs/lv-v1-specification.md` の Lv 式 `max(1, ceil(score/5))` と完全整合。初回バッチ後に 👑 が 0% など極端な分布になった場合のみ § 1-3 の運用ルールに従い境界 75 / 78 への小修正を検討 |
| 3 | 「次の進化まで X 点」の顧客向け開示 | **当面スタッフ向けカードのみで確定**。顧客向け公開（LINE 等）は別途意思決定 |
| 4 | 進化演出の方式 | **(c) 段階チップが下から競り上がる で確定**（§ 3-4 参照）|
| 5 | `mq_last_stage_up_at` を DB に持つか localStorage のみか | **DB カラム `mq_last_stage_up_at timestamptz` を追加**。Lv v1 バッチが書き込む。端末横断で "進化したて" 状態を共有 |
| 6 | sheep / rabbit などおとなしい動物の "凛々しさ" 表現 | **デザインリードに移譲 (Phase 2.5)**。MVP は dog / sheep / rabbit のラフ案を 1 枚ずつ用意してから本実装に進む |

> 6 件すべて 2026-04-26 確定。実装フェーズ (Phase 2.1〜2.3) は本仕様書の通り進めて問題なし。

---

## 8. 参照

- `docs/lv-v1-specification.md` — `mq_lv_score` の定義
- `docs/customer-segmentation-specification.md` — 顧客セグメント定義
- `docs/vip-badges-specification.md` — VIPバッジ仕様
- `public/character.html` — 既存キャラカード (line 498〜597 が `ANIMAL_SVG`)
- `services/questEngine.js` — 旧 Lv 算出（Lv v1 で置換予定）
