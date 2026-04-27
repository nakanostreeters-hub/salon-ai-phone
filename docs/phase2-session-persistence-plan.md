---
name: Phase 2 セッション状態DB永続化 実装計画
description: line_sessions テーブルへの会話状態永続化計画（コミット分割・フラグ・ロールバック手順込み）
type: project
status: draft
date: 2026-04-27
---

# Phase 2: セッション状態のDB永続化 実装計画書

## 0. 目的とスコープ

### 0.1 解決したい問題
- 現状 `services/lineCounselingSession.js` の `sessions` Map はインメモリ。
- Render の再起動・スケール・30分タイムアウトで `conversationState='staff_active'` が消える。
- 結果 → **「スタッフ対応中なのにAIが勝手に話し始める」事故が起きうる**。

### 0.2 ゴール
- `conversationState` を中心とするセッション状態を `line_sessions` テーブルに永続化。
- Phase 1 で追加済み・未接続の `loadConversationHistoryFromDB`（supabase-client.js:358）を活かして、再起動後も会話履歴を復元。
- **既存動作は1ミリも壊さない**。フラグONで初めて新動作。

### 0.3 やらないこと（Phase 2 のスコープ外）
- mq_*（Maikon Quest）連携
- Slack 通知の永続化
- セッション分析・ダッシュボード化
- 全ユーザーへの本番切替（Phase 2 終了後に段階的に行う）

---

## 1. 現状把握（Before）

### 1.1 既存セッションの構造
`services/lineCounselingSession.js` の `Map<userId, session>` で管理されている主要フィールド:

| フィールド | 型 | 用途 | 永続化必須？ |
|---|---|---|---|
| `userId` | string | LINE userId | ✅ PK |
| `conversationState` | enum | `bot_active` / `handoff_pending` / `ai_resumed` / `staff_active` / レガシー | ✅ 最重要 |
| `status` | enum | `counseling` / `handoff_to_staff` | ✅ |
| `assignedStaffId` | string | 引き継ぎ担当 | ✅ |
| `handoffStartedAt` | timestamp | 引き継ぎ開始 | ✅ |
| `staffLastResponseAt` | timestamp | スタッフ最終返信 | ✅ |
| `holdingMessageSent` | bool | 10分SLA一次受け済み | ✅ |
| `displayName` | string | LINE表示名 | ⚪︎ あれば便利 |
| `slackAllThreadTs` 等3つ | string | Slack スレッドts | ⚪︎ |
| `conversationHistory` | array | インメモリ履歴 | ❌ Phase 1 関数で代替 |
| `createdAt`/`updatedAt` | timestamp | 監査用 | ✅ |

### 1.2 セッションを触る箇所（事実ベース）
- `services/lineCounselingSession.js` — 全ての操作API
- `routes/line.js` — 27箇所で getOrCreateSession / patchSession / isStaffActive を使用（line:14-22, 270, 284, 417-418, 445, 489, 945, 965, 1003, 1078, 1100, 1110, 1121, 1132, 1191, 1246, 1310, 1336, 1422 等）
- `routes/api.js:11,552,618,654` — myconダッシュボードからの `markStaffActive` 経由

### 1.3 Phase 1 で既に存在するもの（未接続）
- `supabase-client.js:358` `loadConversationHistoryFromDB(lineUserId, opts)` — conversation_logs から `[{role,content}]` 復元、例外時は空配列。

---

## 2. DB スキーマ設計

### 2.1 新テーブル `line_sessions`
**※ DDL は本計画書の承認後に別タスクで実行。本計画書では SQL を**提示**するのみ（実行しない）。**

```sql
-- migration: phase2_line_sessions.sql
CREATE TABLE IF NOT EXISTS line_sessions (
  line_user_id            text PRIMARY KEY,
  salon_id                uuid NOT NULL,
  conversation_state      text NOT NULL DEFAULT 'bot_active',
  status                  text NOT NULL DEFAULT 'counseling',
  assigned_staff_id       text,
  handoff_started_at      timestamptz,
  staff_last_response_at  timestamptz,
  holding_message_sent    boolean NOT NULL DEFAULT false,
  has_chosen_wait_for_staff boolean NOT NULL DEFAULT false,
  display_name            text,
  slack_all_thread_ts     text,
  slack_stylist_thread_ts text,
  slack_stylist_channel_id text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_line_sessions_salon_state
  ON line_sessions (salon_id, conversation_state);

ALTER TABLE line_sessions ENABLE ROW LEVEL SECURITY;
-- service_role のみ読み書き（既存パターン踏襲）
CREATE POLICY "service_role_only" ON line_sessions
  FOR ALL USING (auth.role() = 'service_role');
```

### 2.2 設計判断
- **PK は `line_user_id` 単独**: salon_id とのコンポジットにしない理由は、既存コードが userId 単独で session を引いているため変更ボラ大。salon_id は付帯情報として保存。
- **conversationHistory は保存しない**: Phase 1 の `loadConversationHistoryFromDB` で conversation_logs から再構築できるため、二重管理を避ける。
- **RLS は service_role のみ**: 既存の `27b40e5` パターン踏襲。

---

## 3. 実装計画（コミット分割）

### 全体方針
- **6コミット構成**。各コミットは単独でロールバック可能（git revert で安全に戻せる粒度）。
- フラグ `SESSION_PERSIST_ENABLED` がデフォルト `false` の間、既存動作と完全に同じ。
- DB書き込みは "**fire-and-forget + 失敗時warn**"。応答パスを await でブロックしない。

---

### コミット A: DDL マイグレーションSQL追加（実行はしない）
**対象**: `scripts/migrate-line-sessions.sql`（新規）
**内容**: 上記 §2.1 の DDL をファイルとして保存するのみ。実行は別ステップで人手承認の後。
**ロールバック**: ファイル削除 / git revert。
**動作確認**: `git log` で追加されたことを確認。本番影響ゼロ。
**所要**: 15分

---

### コミット B: `services/sessionStore.js` 新設（読み書きラッパー、未接続）
**対象**: `services/sessionStore.js`（新規）
**内容**:
- `loadSessionFromDb(lineUserId)` — line_sessions から1行を取得し snake_case → camelCase に変換。失敗時 null。
- `saveSessionToDb(session)` — UPSERT。失敗時 warn のみ、throw しない。
- `deleteSessionFromDb(lineUserId)` — 期限切れ用。
- `mapDbRowToSession(row)` / `mapSessionToDbRow(session)` ヘルパ。

**この時点では誰もこのファイルをimportしない**（後続コミットで接続）。

**ロールバック**: ファイル削除 / git revert。importしている箇所がないので安全。
**動作確認**:
- ファイルが require してもエラーが出ないこと（`node -e "require('./services/sessionStore')"`）。
- 既存LINE webhookの動作には一切影響なし（importされていないため）。
**所要**: 半日

---

### コミット C: `lineCounselingSession.js` に "影書き込み" を追加（フラグでON/OFF）
**対象**: `services/lineCounselingSession.js`
**内容**:
- 環境変数 `SESSION_PERSIST_ENABLED` を読む（未定義 → false）。
- 既存の `getOrCreateSession` / `patchSession` / `markStaffActive` / `resumeAiMode` の**末尾**に、フラグONなら `saveSessionToDb(session)` を fire-and-forget で呼ぶ。
- **読み込みはまだ追加しない**（既存のインメモリ Map がそのまま正）。
- async化はしない（saveSessionToDb は内部で then/catch で握り潰す）。

**この段階の効果**: 本番フラグOFFで何も起きない。フラグONにすると、書き込みだけ行われ、データが line_sessions に蓄積され始める。読み込みはまだインメモリだけ → **挙動はOFF時と完全一致**。

**ロールバック**: git revert。
**動作確認**:
1. フラグOFFで既存動作（LINE 受信→AI応答→引き継ぎ→staff_active 排他制御→AI再開）が全てそのまま動くこと。
2. ステージングでフラグONにして、line_sessions に行が増えていくことをSQLで確認。
3. インメモリ動作はON/OFFどちらでも同じであることを確認。
**所要**: 1日

---

### コミット D: ハイブリッドread（DBフォールバック）追加
**対象**: `services/lineCounselingSession.js`
**内容**:
- `getOrCreateSession(userId)` 内、Map に無く（または期限切れ）な場合、フラグONなら `loadSessionFromDb` を試行。
- ヒットしたら Map に復元してからリターン。失敗・該当なしなら従来通り新規作成。
- `getSession(userId)` も同様。
- 既存呼び出し箇所のシグネチャは**一切変えない**（同期APIのまま）。
  - 実装上、初回 webhook イベントで非同期loadが必要 → **対策**: `routes/line.js` の webhook handler 入口に1箇所だけ `await hydrateSessionFromDb(userId)` を追加（後述のコミットEで対応）。

**設計上の注意**:
- このコミット単体ではまだ `routes/line.js` を変更しないので、**インメモリにあるセッションは従来通り、無いセッションだけDBから復元される**動きになる。
- フラグOFFなら100%既存動作。

**ロールバック**: git revert。
**動作確認**:
1. フラグOFFで全機能を回帰テスト。
2. ステージングでフラグONにし、Renderを手動再起動 → 直前にstaff_activeだったユーザーが、再起動後の最初のメッセージで isStaffActive=true を維持していること（**今回の事故防止の核心**）。
3. DBに行が無いユーザー（新規）はこれまで通り新規作成。
**所要**: 1日

---

### コミット E: `routes/line.js` webhook 入口に hydrate を1箇所だけ追加
**対象**: `routes/line.js`
**内容**:
- webhook イベントループの先頭（events.forEach の中、各イベント先頭）に:
  ```js
  if (process.env.SESSION_PERSIST_ENABLED === 'true') {
    await hydrateSessionFromDb(userId); // 失敗時はno-op
  }
  ```
- `hydrateSessionFromDb` は `services/lineCounselingSession.js` に追加（DB→Map に復元するヘルパ、Mapに既にあれば何もしない）。
- それ以外の関数シグネチャは同期のまま据え置き。

**設計上の注意**:
- 既に `routes/line.js` の handler は async。 `await` を1行足すだけなのでasync伝播は最小。
- フラグOFFなら hydrate は実行されず、追加コスト 0。

**ロールバック**: git revert。1ファイルの最小diff。
**動作確認**:
1. フラグOFFで全機能を回帰テスト（普段の動作）。
2. ステージングでフラグONにし、再起動シナリオを実機で再現:
   - スタッフが mycon から返信 → staff_active
   - Render再起動（手動 or デプロイ）
   - お客様がLINEで返信 → **AIが反応しないこと**を確認
3. 同シナリオでフラグOFFだと従来通りAIが反応してしまうことを再現確認（フラグの有効性確認）。
**所要**: 半日

---

### コミット F: 期限切れクリーンアップのDB側実装＋運用ドキュメント
**対象**:
- `services/lineCounselingSession.js` の `cleanupExpiredSessions` がフラグONなら DB側も `deleteSessionFromDb` を呼ぶ。
- `docs/phase2-session-persistence-plan.md` にロールアウト手順と運用メモを追記（または別docs作成）。

**ロールバック**: git revert。
**動作確認**: 30分以上操作のないステージングユーザーが、メモリからもDBからも消えること。
**所要**: 半日

---

## 4. 環境変数フラグ

### 4.1 仕様
| 変数名 | 型 | デフォルト | 役割 |
|---|---|---|---|
| `SESSION_PERSIST_ENABLED` | `'true'` / それ以外 | 未定義（=OFF） | DB read/write を有効化 |

### 4.2 ON にするタイミング
1. **コミットA-F全マージ後、本番デプロイ済み**で、フラグはまだOFF。
2. ステージング（または1サロンのみ）でフラグONにし、最低1週間観察（書き込み成功率、リクエストレイテンシ、エラーログ）。
3. 問題なければ本番でフラグON。
4. 万が一の事故時は **Render の env を `false` に戻すだけ**で旧動作に即座に戻る（コードロールバック不要）。

### 4.3 フラグ判定の中央化
`SESSION_PERSIST_ENABLED` の参照は `services/sessionStore.js` の `isPersistEnabled()` 関数1箇所に集約し、各所はそれを呼ぶ。後で「サロンごとに段階導入」したくなった時、ここを `salon_config.session_persist_enabled` に差し替えるだけで済む。

---

## 5. 既存動作を壊さないための工夫

### 5.1 async化を最小限に
- セッション操作API (`getOrCreateSession`, `patchSession` etc) は**同期APIのまま**。書き込みは fire-and-forget で内部async。
- 読み込みは webhook 入口の1箇所のみ `await` を追加（コミットE）。
- これにより既存27箇所の呼び出し箇所のシグネチャ変更ゼロ。

### 5.2 後方互換
- `conversation_state` の値は既存と同じ文字列をそのまま使う（`bot_active` / `staff_active` / `human_active` レガシー含む）。
- DBスキーマに将来追加カラムが必要になっても、既存コードを壊さないよう全て NULLABLE で追加。

### 5.3 フォールバック
- DB read 失敗 → 空（Mapで新規作成）。AIが応答してしまう可能性はあるが、これは**現状と同じ動作**なので退行ではない。
- DB write 失敗 → warn ログのみ。Mapには書き込み成功しているので応答動作には影響なし。
- DBが完全停止 → フラグONでもメッセージ応答は動く（書き込みエラーが warn として残るだけ）。

### 5.4 race condition の扱い
- 同一ユーザーから連続webhookが来た場合、現状でも Map の書き込みは順序保証なし → 仕様変更なし。
- DB UPSERT は `updated_at` で最終勝ちにする。Mapとの不整合は次回 hydrate で揃う。

---

## 6. 動作確認・テストケース

### 6.1 フラグOFF回帰（全コミット共通）
| # | シナリオ | 期待動作 |
|---|---|---|
| R1 | 通常のAI応答 | 既存通り動作 |
| R2 | 引き継ぎフロー（handoff_pending → staff_active） | 既存通り動作 |
| R3 | お客様によるAI再開（ai_resumed） | 既存通り動作 |
| R4 | 30分タイムアウト | Mapから消える、DBは触らない |
| R5 | mycon からのスタッフ返信 → AI排他制御 | 既存通り動作 |

### 6.2 フラグON動作確認（コミットE後）
| # | シナリオ | 期待動作 |
|---|---|---|
| P1 | 通常応答 → DBに行が追加 | line_sessions にレコード |
| P2 | staff_active 中に Render 再起動 → 顧客が返信 | **AI応答しない**（事故防止） |
| P3 | ai_resumed 中に再起動 → 顧客が返信 | AI応答する |
| P4 | DB一時停止中の応答 | warn が出るが応答は通る |
| P5 | 30分後 → Map と DB 両方から消える | OK |

---

## 7. ロールバック手順

### 7.1 コードロールバック（コミット単位）
- 各コミットは独立しており `git revert <hash>` で順方向の打ち消しコミットを作れる。
- F → E → D → C → B → A の逆順で revert すれば任意の状態まで戻せる。

### 7.2 緊急時の最速ロールバック（コードを触らない）
1. Render Dashboard で `SESSION_PERSIST_ENABLED` を `false` にする。
2. サービス再起動（自動 or 手動）。
3. これで挙動は完全に Phase 1 以前と同じ（DB書き込み・読み込みなし）。

### 7.3 DBマイグレーション戻し
- 実害がない限り **DROP TABLE はしない**（戻したい場合に再導入が手間）。
- どうしても消したい場合:
  ```sql
  DROP TABLE IF EXISTS line_sessions;
  ```
- フラグOFFなら `line_sessions` テーブルがあっても誰も読み書きしないので、放置でも実害ゼロ。

---

## 8. 工数見積もり

| コミット | 内容 | 見積 |
|---|---|---|
| A | DDL SQL ファイル追加 | 0.25日 |
| B | sessionStore.js 新設 | 0.5日 |
| C | 影書き込み追加（フラグ付） | 1日 |
| D | ハイブリッドread | 1日 |
| E | webhook入口に hydrate | 0.5日 |
| F | クリーンアップDB対応＋運用doc | 0.5日 |
| | **計** | **3.75日（実装）** |
| 検証 | ステージングで 1週間観察 | 別途7日（Calendar） |

**ボトルネック想定**:
- C と D の境目で**「Mapが正か、DBが正か」の二重正典問題**を踏みやすい → 「Mapが優先、DBは"消えた時の保険"」と設計を貫く。
- E でwebhook入口に1行 await を入れる箇所は `routes/line.js` の forEach 構造を確認しておく。

---

## 9. ロールアウトプラン（実装後の話、参考）

1. 全コミットマージ → 本番デプロイ（フラグOFFのまま）
2. 1サロン（PREMIER MODELS のみ）でフラグON、1週間観察
3. ログメトリクス確認: 書き込み成功率 > 99%、レイテンシ追加 < 50ms
4. 全サロンON
5. 1ヶ月後、フラグ撤去（コード簡素化）の判断

---

## 10. 未確定事項（実装着手前に確認したいこと）

1. `salon_id` のNOT NULL制約 — 既存セッションには salon_id が常に紐づくか？ `routes/line.js` で確認後にDDL確定したい。
2. RLSポリシー — 既存テーブル（customers, conversation_logs等）と同じで service_role only でよいか？
3. ロールアウト時にON対象サロンを段階的にしたい場合、フラグを `salon_config` に持たせるか env のままか？
4. Render の Starter プランで pg接続数に余裕はあるか？（write追加で接続増）→ 既存接続をそのまま使うので影響軽微の見込み。

---

## 11. 関連ファイル参照（事実ベース）

- `services/lineCounselingSession.js` — Phase 1 時点でインメモリ実装（203行）
- `services/sessionStore.js` — Phase 2 (B) で追加した DB ラッパー
- `supabase-client.js:358` — Phase 1 で追加済みの `loadConversationHistoryFromDB`（未接続）
- `scripts/migrate-line-sessions.sql` — Phase 2 (A) で追加したDDL（未実行）
- `routes/line.js` — セッション利用箇所27箇所、webhook入口3箇所に hydrate 追加済（コミットE）
- `routes/api.js:11,552,618,654` — mycon側からの markStaffActive 経路
- Phase 2 コミット: A=`8b3e024` / B=`b58b5a1` / C=`8f05d56` / D=`633c468` / E=`da2866d` / F=本コミット
- 関連参考: `4f6f9cf` handoff MVP, `24d9c81` Phase 1 履歴復元関数, `e4a9075` AI ON/OFFトグル

---

## 12. 運用ノート（実装完了後）

### 12.1 DDL 実行（コミットA以降、フラグON前に必須）
```bash
# Supabase Studio の SQL Editor または psql で実行
psql "$SUPABASE_DB_URL" -f scripts/migrate-line-sessions.sql
```
実行後の確認:
```sql
SELECT COUNT(*) FROM public.line_sessions;          -- 0件のはず
SELECT * FROM pg_policies WHERE tablename='line_sessions'; -- service_role_only ポリシー存在
```

### 12.2 フラグONの段階導入
| ステージ | 環境 | 期間 | 観察ポイント |
|---|---|---|---|
| 1 | Render 環境変数追加（OFF）| 即 | ENV変更後に再デプロイされていることを確認 |
| 2 | ステージング ON | 数時間 | line_sessions に行が増えること、エラーログがないこと |
| 3 | 本番 ON（PREMIER MODELS のみ）| 1週間 | 書き込み成功率、レイテンシ追加分、staff_active 復元が機能しているか |
| 4 | 全サロン ON | 必要時 | （現状は1サロンしかいないので即時=完了） |

### 12.3 緊急時のロールバック（最速）
1. Render Dashboard で `SESSION_PERSIST_ENABLED` を空 or `false` に変更。
2. サービス再起動（自動）。
3. これでDB読み書きが止まり、**Phase 1 以前と完全に同じ動作**に戻る。
4. line_sessions テーブルは放置で問題なし（誰も触らないので残骸が消えていくだけ）。

### 12.4 監視ポイント
- ログに `[SessionStore]` で始まる warn が継続的に出ていないか。
- Renderダッシュボードでpg接続数の急増がないか（fire-and-forget設計のため通常は接続が貯まらない）。
- `line_sessions.updated_at` が進捗していること（書き込みが届いている証跡）。

### 12.5 line_sessions の手動メンテナンス例
```sql
-- ある userId のセッションを強制リセット（顧客サポート時など）
DELETE FROM public.line_sessions WHERE line_user_id = 'Uxxxxxx';

-- 24時間以上更新のないセッションを一括削除（cleanupExpiredSessionsの保険）
DELETE FROM public.line_sessions WHERE updated_at < now() - interval '24 hours';

-- 現在 staff_active のセッション一覧
SELECT line_user_id, salon_id, conversation_state, updated_at
FROM public.line_sessions
WHERE conversation_state = 'staff_active'
ORDER BY updated_at DESC;
```

