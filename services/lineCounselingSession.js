// ============================================
// services/lineCounselingSession.js
// LINE AIカウンセリング セッション管理
// ============================================

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30分

// セッションストア（インメモリ）
const sessions = new Map();

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
 * セッションを削除
 * @param {string} userId
 */
function deleteSession(userId) {
  sessions.delete(userId);
}

/**
 * 期限切れセッションのクリーンアップ
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
};
