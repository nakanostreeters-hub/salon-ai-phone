// ============================================
// services/lineCounselingSession.js
// LINE AIカウンセリング セッション管理
// ============================================

const sessionStore = require('./sessionStore');

// インメモリ session の有効期限。これを超えてアイドルの session は
// cleanupExpiredSessions（10分周期）または次回アクセス時の lazy 判定で
// Map から外される。Phase 2 (G) 以降 DB の line_sessions 行は残置されるため、
// 期限超過後でも会話状態（conversation_state, displayName 等）は復元可能だが、
// 紐付けフロー進行中の linking state はメモリ専用のため期限超過で失われる。
// 仮説F（小西さん事例：46分後の本人確認入力で紐付け状態消失）の対応として、
// 多くのお客様の応答間隔を吸収できる 24 時間に延長。
const SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24時間

// セッションストア（インメモリ）
const sessions = new Map();

/**
 * Phase 2: フラグONのとき、セッション内容をDBへ非同期で永続化する。
 * fire-and-forget。Promise を await せず、失敗しても応答パスは止めない。
 * フラグOFF時は何もしない（即return）。
 */
function persistAsync(session) {
  if (!session) return;
  if (!sessionStore.isPersistEnabled()) return;
  // .catch で握り潰す。saveSessionToDb 内でも warn 済みのため通常は到達しない。
  Promise.resolve()
    .then(() => sessionStore.saveSessionToDb(session))
    .catch((err) => {
      console.warn('[LINE Session] persistAsync エラー:', err && err.message);
    });
}

/**
 * セッションを取得または新規作成
 * @param {string} userId - LINE userId
 * @returns {object} session
 */
function getOrCreateSession(userId) {
  const now = Date.now();

  if (sessions.has(userId)) {
    const session = sessions.get(userId);
    // 30分以上経過していたらリセット
    if (now - session.updatedAt > SESSION_TIMEOUT_MS) {
      console.log(`[LINE Session] タイムアウトによりリセット: ${userId}`);
      sessions.delete(userId);
    } else {
      session.updatedAt = now;
      return session;
    }
  }

  // 新規セッション作成
  const session = {
    userId,
    conversationHistory: [],
    status: 'counseling', // 'counseling' | 'handoff_to_staff'
    // 引き継ぎフロー用の状態管理
    //   ai_active       : 通常のAI応答モード（= 旧 bot_active。互換のため bot_active も使用可）
    //   handoff_pending : AIが引き継ぎ判定し、スタッフ返信を待機中
    //   ai_resumed      : お客様が「AIに相談する」ボタンを押してAI応答を再開した状態
    //   staff_active    : スタッフが返信を開始し、AIは排他制御で応答停止（= 旧 human_active）
    //   cooldown / closed : レガシー
    conversationState: 'bot_active',
    assignedStaffId: null,
    handoffStartedAt: null,
    staffLastResponseAt: null,
    holdingMessageSent: false, // 10分SLAで業務的な一次受けを送ったか
    createdAt: now,
    updatedAt: now,
    displayName: null,
    slackAllThreadTs: null,       // #受付-全件のスレッドts
    slackStylistThreadTs: null,   // 担当チャンネルのスレッドts
    slackStylistChannelId: null,  // 担当チャンネルID
  };
  sessions.set(userId, session);
  console.log(`[LINE Session] 新規セッション作成: ${userId}`);
  persistAsync(session);
  return session;
}

/**
 * セッションを取得（存在しなければ null）
 * @param {string} userId
 * @returns {object|null}
 */
function getSession(userId) {
  if (!sessions.has(userId)) return null;
  const session = sessions.get(userId);
  const now = Date.now();
  if (now - session.updatedAt > SESSION_TIMEOUT_MS) {
    sessions.delete(userId);
    return null;
  }
  return session;
}

/**
 * 会話履歴にメッセージを追加
 * @param {string} userId
 * @param {string} role - 'user' | 'assistant'
 * @param {string} content
 */
function addMessage(userId, role, content) {
  const session = getOrCreateSession(userId);
  session.conversationHistory.push({ role, content });
  session.updatedAt = Date.now();
  persistAsync(session);
}

/**
 * セッションのステータスを変更
 * @param {string} userId
 * @param {string} status - 'counseling' | 'handoff_to_staff'
 */
function setStatus(userId, status) {
  const session = getSession(userId);
  if (session) {
    session.status = status;
    session.updatedAt = Date.now();
    persistAsync(session);
  }
}

/**
 * セッションの表示名を設定
 * @param {string} userId
 * @param {string} displayName
 */
function setDisplayName(userId, displayName) {
  const session = getSession(userId);
  if (session) {
    session.displayName = displayName;
    persistAsync(session);
  }
}

/**
 * 引き継ぎフロー用の状態をまとめて更新
 * @param {string} userId
 * @param {object} patch - { conversationState, assignedStaffId, handoffStartedAt, staffLastResponseAt, holdingMessageSent }
 */
function patchSession(userId, patch) {
  const session = getSession(userId);
  if (!session) return;
  Object.assign(session, patch);
  session.updatedAt = Date.now();
  persistAsync(session);
}

function setConversationState(userId, state) {
  patchSession(userId, { conversationState: state });
}

/**
 * スタッフが返信したことを記録してAIを排他制御する
 * conversationState = 'staff_active' に遷移し、以降 AI は応答しない
 */
function markStaffActive(userId) {
  patchSession(userId, {
    conversationState: 'staff_active',
    staffLastResponseAt: Date.now(),
  });
}

/**
 * お客様主導で AI モードを再開する
 * status: 'counseling', conversationState: 'ai_resumed' に遷移
 * SLAタイマーや一次受け送信フラグはクリアする
 */
function resumeAiMode(userId) {
  const session = getSession(userId);
  if (!session) return null;
  session.status = 'counseling';
  session.conversationState = 'ai_resumed';
  session.holdingMessageSent = false;
  session.updatedAt = Date.now();
  persistAsync(session);
  return session;
}

/**
 * AI 応答が抑止されるべき状態か判定（スタッフ応対中）
 */
function isStaffActive(session) {
  if (!session) return false;
  return (
    session.conversationState === 'staff_active' ||
    session.conversationState === 'human_active' // レガシー互換
  );
}

/**
 * Phase 2: 必要に応じて DB からセッションを復元して Map に載せる。
 *
 * - フラグ OFF / userId 不在なら即 null。
 * - Map に有効なセッションがあれば DB は見ない（Map が常に正典）。
 * - DB ヒット時は updatedAt を「現在時刻」に書き換えて Map に投入する
 *   （DB の updated_at をそのまま使うと、復元直後にタイムアウト判定で
 *    消されてしまうケースがあるため）。
 * - conversationHistory は空配列で初期化（Phase 1 の
 *   loadConversationHistoryFromDB で別途復元する想定）。
 * - 失敗・該当なしは null を返し、後続の getOrCreateSession で
 *   従来通り新規作成される。
 *
 * webhook 入口（routes/line.js）から1度だけ await することを想定。
 */
async function hydrateSessionFromDb(userId) {
  if (!sessionStore.isPersistEnabled()) return null;
  if (!userId) return null;
  const now = Date.now();
  const existing = sessions.get(userId);
  if (existing && now - existing.updatedAt <= SESSION_TIMEOUT_MS) {
    return existing;
  }
  try {
    const fromDb = await sessionStore.loadSessionFromDb(userId);
    if (!fromDb) return null;
    fromDb.conversationHistory = [];
    fromDb.updatedAt = now;
    sessions.set(userId, fromDb);
    console.log(`[LINE Session] DB から復元: ${userId} (state=${fromDb.conversationState})`);
    return fromDb;
  } catch (err) {
    console.warn('[LINE Session] hydrateSessionFromDb 例外:', err && err.message);
    return null;
  }
}

/**
 * セッションを削除
 * @param {string} userId
 */
function deleteSession(userId) {
  sessions.delete(userId);
}

/**
 * 期限切れセッションのクリーンアップ
 *
 * Phase 2 (c案): インメモリ Map のエントリだけクリアする。
 * DB 上の line_sessions 行は残置し、後続の webhook で
 * hydrateSessionFromDb 経由で staff_active 等の状態を復元できる
 * ようにする（プロセス再起動耐性／田丸さん事故再発防止）。
 *
 * 古い DB 行の整理は Phase 3 もしくは運用 SQL（updated_at 基準の
 * バッチ DELETE）で別途対応する前提。
 */
function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [userId, session] of sessions) {
    if (now - session.updatedAt > SESSION_TIMEOUT_MS) {
      sessions.delete(userId);
      console.log(`[LINE Session] 期限切れ削除: ${userId}`);
    }
  }
}

// 10分ごとにクリーンアップ実行
setInterval(cleanupExpiredSessions, 10 * 60 * 1000);

module.exports = {
  getOrCreateSession,
  getSession,
  addMessage,
  setStatus,
  setDisplayName,
  deleteSession,
  cleanupExpiredSessions,
  patchSession,
  setConversationState,
  markStaffActive,
  resumeAiMode,
  isStaffActive,
  hydrateSessionFromDb,
};
