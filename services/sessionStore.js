// ============================================
// services/sessionStore.js
// Phase 2: line_sessions テーブルへの読み書きラッパー
//
// 本ファイルは Phase 2 (B) コミット時点では誰からも import されない。
// 後続コミット (C, D, F) で services/lineCounselingSession.js から呼ばれる。
//
// 設計方針:
//   - 失敗は throw せず、warn ログのみ。応答パスを止めない。
//   - フラグ SESSION_PERSIST_ENABLED='true' のときだけ実際にDBアクセス。
//     OFF時は早期returnで何もしない。
//   - salon_id NOT NULL — session.salonId が無ければ process.env.SALON_ID で補完。
//     どちらも無ければ書き込みをスキップ。
// ============================================

const { getAdminClient } = require('../supabase-client');

/**
 * フラグ判定の中央化。
 * 将来 salon_config に切り替えたい場合はこの関数を差し替えるだけで済む。
 */
function isPersistEnabled() {
  return process.env.SESSION_PERSIST_ENABLED === 'true';
}

/**
 * DB行 → セッションオブジェクト（camelCase）に変換。
 */
function mapDbRowToSession(row) {
  if (!row) return null;
  return {
    userId: row.line_user_id,
    salonId: row.salon_id,
    conversationState: row.conversation_state,
    status: row.status,
    assignedStaffId: row.assigned_staff_id,
    handoffStartedAt: row.handoff_started_at
      ? new Date(row.handoff_started_at).getTime()
      : null,
    staffLastResponseAt: row.staff_last_response_at
      ? new Date(row.staff_last_response_at).getTime()
      : null,
    holdingMessageSent: row.holding_message_sent === true,
    hasChosenWaitForStaff: row.has_chosen_wait_for_staff === true,
    displayName: row.display_name,
    slackAllThreadTs: row.slack_all_thread_ts,
    slackStylistThreadTs: row.slack_stylist_thread_ts,
    slackStylistChannelId: row.slack_stylist_channel_id,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
  };
}

/**
 * セッションオブジェクト → DB行（snake_case）に変換。
 * salon_id が解決できない場合は null を返し、書き込みをスキップさせる。
 */
function mapSessionToDbRow(session) {
  if (!session || !session.userId) return null;
  const salonId = session.salonId || process.env.SALON_ID;
  if (!salonId) return null;
  return {
    line_user_id: session.userId,
    salon_id: salonId,
    conversation_state: session.conversationState || 'bot_active',
    status: session.status || 'counseling',
    assigned_staff_id: session.assignedStaffId || null,
    handoff_started_at: session.handoffStartedAt
      ? new Date(session.handoffStartedAt).toISOString()
      : null,
    staff_last_response_at: session.staffLastResponseAt
      ? new Date(session.staffLastResponseAt).toISOString()
      : null,
    holding_message_sent: session.holdingMessageSent === true,
    has_chosen_wait_for_staff: session.hasChosenWaitForStaff === true,
    display_name: session.displayName || null,
    slack_all_thread_ts: session.slackAllThreadTs || null,
    slack_stylist_thread_ts: session.slackStylistThreadTs || null,
    slack_stylist_channel_id: session.slackStylistChannelId || null,
    updated_at: new Date().toISOString(),
  };
}

/**
 * line_sessions から1行を取得し、セッションオブジェクトに変換して返す。
 * 例外時・未ヒット時は null。throw しない。
 */
async function loadSessionFromDb(lineUserId) {
  if (!isPersistEnabled()) return null;
  if (!lineUserId) return null;
  const client = getAdminClient();
  if (!client) return null;
  try {
    const { data, error } = await client
      .from('line_sessions')
      .select('*')
      .eq('line_user_id', lineUserId)
      .maybeSingle();
    if (error) {
      console.warn('[SessionStore] loadSessionFromDb 失敗:', error.message);
      return null;
    }
    return mapDbRowToSession(data);
  } catch (err) {
    console.warn('[SessionStore] loadSessionFromDb 例外:', err && err.message);
    return null;
  }
}

/**
 * UPSERT。fire-and-forget で呼べるよう Promise を返すが throw しない。
 */
async function saveSessionToDb(session) {
  if (!isPersistEnabled()) return false;
  const row = mapSessionToDbRow(session);
  if (!row) return false;
  const client = getAdminClient();
  if (!client) return false;
  try {
    const { error } = await client
      .from('line_sessions')
      .upsert(row, { onConflict: 'line_user_id' });
    if (error) {
      console.warn('[SessionStore] saveSessionToDb 失敗:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[SessionStore] saveSessionToDb 例外:', err && err.message);
    return false;
  }
}

/**
 * line_sessions から1行を削除（期限切れクリーンアップ用）。
 */
async function deleteSessionFromDb(lineUserId) {
  if (!isPersistEnabled()) return false;
  if (!lineUserId) return false;
  const client = getAdminClient();
  if (!client) return false;
  try {
    const { error } = await client
      .from('line_sessions')
      .delete()
      .eq('line_user_id', lineUserId);
    if (error) {
      console.warn('[SessionStore] deleteSessionFromDb 失敗:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[SessionStore] deleteSessionFromDb 例外:', err && err.message);
    return false;
  }
}

module.exports = {
  isPersistEnabled,
  loadSessionFromDb,
  saveSessionToDb,
  deleteSessionFromDb,
  mapDbRowToSession,
  mapSessionToDbRow,
};
