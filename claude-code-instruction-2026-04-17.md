# Claude Code 指示書 — 2026-04-17

salon-ai-phone リポジトリに対して、2つの改修を順番に実施してください。

---

## 前提

- 作業リポジトリ: `~/salon-ai-phone`
- ブランチ: `main`(直コミットでOK)
- 参考Notion:
  - Supabase接続調査 2026-04-16(既存顧客誤認識問題のセクション)
  - 待機中UX設計 — お客様主導でAIを呼び起こす(https://www.notion.so/345275ccca5881658fcdf7ab7abccd4f)

---

## Task 1: カルテ誤認識バグの修正【最優先】

### 背景

LINE実機テストで、48回来店の常連(田丸弘美さん, karte_no=9215)に対してAIが「新規のお客様でいらっしゃいます」と応答してしまった。原因は `ai-receptionist.js` の `buildKarteContext()` が `visits` 配列の長さだけで判定しており、`customers` テーブルの `visit_count` / `last_visit_at` / `customer_segment` を無視しているため。

visits テーブルは初期CSVインポートが不完全で227件しか入っていない(customers は11,547件)。visits が空でも customers 側の情報で既存顧客判定ができる必要がある。

### 修正内容

#### A. `ai-receptionist.js` の `buildKarteContext()` 修正(180〜215行目)

既存顧客判定ロジックを3層に変更:

```javascript
// 1. 既存顧客判定(customersテーブルの一次情報)
const isExistingCustomer = 
  (customer.visit_count && customer.visit_count > 0) ||
  customer.last_visit_at;

if (isExistingCustomer) {
  context += `来店回数: ${customer.visit_count || '不明'}回\n`;
  if (customer.last_visit_at) {
    context += `最終来店日: ${customer.last_visit_at}\n`;
  }
  if (customer.customer_segment) {
    context += `顧客セグメント: ${customer.customer_segment}\n`;
  }
  
  // 2. 詳細履歴があれば追加(visitsテーブルの補強情報)
  if (visits.length > 0) {
    context += '\n来店履歴詳細:\n';
    // 既存のvisits展開ロジック
  } else {
    context += '※詳細履歴はデータ未整備のため参照不可\n';
  }
} else {
  // 3. 本当に新規の可能性
  context += '来店履歴: なし(新規のお客様の可能性)\n';
}
```

#### B. `prompts/freelanceCounseling.js` にプロンプト防御を追加

システムプロンプトに以下のルールを明記:

```
## 重要: 既存顧客の扱い

- カルテ情報に「来店回数」が1以上、または「最終来店日」が記載されている場合、そのお客様は既存の常連客です。
- 既存顧客に対して、以下の表現は絶対に使わないでください:
  ✗ 「新規のお客様」
  ✗ 「初回」「初めて」「はじめまして」
  ✗ 「ご利用ありがとうございます」(初回来店時のような言い方)

- 既存顧客に対する推奨表現:
  ✓ 「お久しぶりです」
  ✓ 「前回からお時間が空いていますね」
  ✓ 「いつもご利用ありがとうございます」

- 「顧客セグメント」が「固定失客」の場合は、久しぶりの方です。再会を歓迎する自然な対応を。
```

#### C. 検証

修正後、田丸さんのLINE IDで「カラーしたいです」などと送って、以下を確認:
- AI応答に「新規」「初回」「はじめまして」が含まれないこと
- 「お久しぶりです」系の表現が出ること
- カルテ番号9215の情報(来店回数48、最終来店日2025-01-09、固定失客)が正しくプロンプトに注入されていること

### コミットメッセージ例

```
Fix: 既存顧客を新規と誤認識するバグを修正

- buildKarteContext でcustomers.visit_count / last_visit_at / customer_segment を既存顧客判定の一次情報として使用
- visits配列はあくまで詳細履歴の補強情報として扱う
- プロンプトに既存顧客判定ルールと禁止/推奨表現を追加

影響: 48回来店の常連(田丸さん等)に「新規のお客様」と応答する問題を解消
```

---

## Task 2: AI呼び起こしボタンの実装

### 背景

Notion「待機中UX設計」参照。

引き継ぎモード中、お客様に「ただ待つ」だけでなく「自分のタイミングでAIを呼び起こせる」選択肢を渡す設計。

### 実装仕様

#### A. 引き継ぎメッセージにPostbackボタンを追加

`routes/line.js`(または引き継ぎ処理のモジュール)で、引き継ぎ完了時の応答メッセージを以下のFlex Message(またはQuick Reply)に変更:

```javascript
// 引き継ぎ完了メッセージ
{
  type: 'flex',
  altText: '担当者に引き継ぎました',
  contents: {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'text',
          text: '担当者に引き継ぎました🙇‍♀️\n少しお時間いただきます🙏',
          wrap: true
        }
      ]
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'button',
          action: {
            type: 'postback',
            label: '🤖 AIに相談する',
            data: 'action=resume_ai',
            displayText: 'AIに相談する'
          },
          style: 'primary'
        }
      ]
    }
  }
}
```

#### B. Postback受信ハンドラ

`routes/line.js` で `event.type === 'postback'` をハンドリング:

```javascript
if (event.type === 'postback') {
  const data = new URLSearchParams(event.postback.data);
  if (data.get('action') === 'resume_ai') {
    // セッションの handoff_status を 'ai_resumed' に変更
    await resumeAiMode(userId);
    
    // お客様に復帰メッセージ
    return {
      type: 'text',
      text: 'お待たせしてすみません😊\nどんなことでしょう?'
    };
  }
}
```

#### C. セッション状態の拡張

`sessions` テーブル(またはセッション管理ロジック)に以下のステータスを追加:

- `ai_active`: 通常のAI応答モード
- `handoff_pending`: 引き継ぎ済み、スタッフ返信待ち
- `ai_resumed`: お客様がAI呼び起こしを選択し、AIが再応答中
- `staff_active`: スタッフが返信を開始(AI排他制御発動)

#### D. 排他制御: スタッフ介入検知

mycon からスタッフが返信を送信した瞬間、当該セッションを `staff_active` に遷移させる。以降AIは応答しない。

実装箇所: mycon → LINE送信のエンドポイント(推定: `routes/mycon.js` など)

```javascript
// スタッフがLINE送信した瞬間
await updateSessionStatus(userId, 'staff_active');
```

#### E. mycon側の可視化(最低限)

「このセッションは現在AI応答中」「スタッフ応答中」「待機中」が一目で分かるようにバッジ表示。今回はAPI側で `session.handoff_status` を返すだけでOK、UI側の実装は別タスクとして切り出す。

### 検証シナリオ

1. 通常のカウンセリングから引き継ぎモードに遷移
2. 引き継ぎメッセージに「AIに相談する」ボタンが表示される
3. ボタンを押す → AIが応答再開する
4. その後スタッフがmyconから返信 → セッションが `staff_active` になる
5. お客様が再度メッセージ送信 → AIは応答しない(スタッフのみ対応)

### コミットメッセージ例

```
Feature: 引き継ぎ中にお客様主導でAIを呼び起こせるボタンを追加

- 引き継ぎ完了メッセージにPostback「AIに相談する」ボタンを実装
- postbackハンドラでAIモード再開ロジック追加
- sessionに ai_resumed / staff_active ステータスを追加
- スタッフがmyconから返信した瞬間にAI排他制御を発動

設計思想: システム主導タイマーではなく、お客様主導でAIを呼び起こせる形にすることで、
待ち時間の不安を軽減しつつスタッフ側の返信機会も奪わない。
```

---

## 作業順序

1. **Task 1(バグ修正)を先に実施** → ブランチ: 直コミット可
2. Task 1 のテストで田丸さんケースが解消したことを確認
3. **Task 2(AI呼び起こしボタン)を実施**
4. 両方pushしたらHirokiに報告

---

## 注意事項

- API鍵は `.env` に追加するのみ。実キー値は記載しない
- 既存の `routes/line.js` や `services/customerLinking.js` の他の機能を壊さない
- `npm test` があれば実行、なければ最低限起動確認
- 不明点があれば、コミット前に質問すること
