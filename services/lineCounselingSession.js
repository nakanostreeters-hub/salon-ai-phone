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
};
