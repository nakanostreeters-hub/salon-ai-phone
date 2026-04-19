// ============================================
// supabase-client.js
// Supabase 顧客データ取得サービス
// ============================================
const { createClient } = require('@supabase/supabase-js');

let anonClient = null;
let adminClient = null;

/**
 * サービスロールキーを使うadminクライアント（RLSをバイパス）。
 * LINE Webhook、監査ログ、システム書き込みなどユーザーJWTを経由しない
 * サーバー内部処理はこれを使う。SERVICE_ROLE_KEY が無ければ null を返す。
 */
function getAdminClient() {
  if (adminClient) return adminClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  adminClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return adminClient;
}

/**
 * サーバー内部用クライアント。
 * 優先順位:
 *   1) SUPABASE_SERVICE_ROLE_KEY があれば admin（RLSバイパス）
 *   2) 無ければ ANON_KEY でフォールバック（RLSの影響を受ける）
 */
function getClient() {
  const admin = getAdminClient();
  if (admin) return admin;
  if (!anonClient && process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    anonClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );
  }
  return anonClient;
}

/**
 * 認証用の anon クライアントを取得（routes/api.js のログイン等で使用）。
 */
function getAnonClient() {
  if (!anonClient && process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    anonClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );
  }
  return anonClient;
}

// 電話番号で顧客を検索
async function findCustomerByPhone(phone) {
  const client = getClient();
  if (!client) return null;

  const { data, error } = await client
    .from('customers')
    .select('*')
    .eq('phone', phone)
    .single();

  if (error) {
    console.error('[Supabase] 顧客検索エラー (phone):', error.message);
    return null;
  }
  return data;
}

// line_id カラムの存在フラグ（初回の検索でスキーマエラーが出たらfalseにして以降スキップ）
let hasLineIdColumn = true;

// LINE IDで顧客を検索
async function findCustomerByLineId(lineId) {
  const client = getClient();
  if (!client) return null;
  if (!hasLineIdColumn) return null;

  const { data, error } = await client
    .from('customers')
    .select('*')
    .eq('line_id', lineId)
    .maybeSingle();

  if (error) {
    // line_id カラムが存在しない場合は以降スキップ
    if (error.message && error.message.includes('line_id does not exist')) {
      hasLineIdColumn = false;
      console.warn('[Supabase] customers.line_id カラム未作成のため LINE ID 検索をスキップします');
      return null;
    }
    // 該当なしは maybeSingle でエラーにならないが、念のため
    if (error.code === 'PGRST116') return null;
    console.error('[Supabase] 顧客検索エラー (line_id):', error.message);
    return null;
  }
  return data;
}

// 顧客の直近5回の来店履歴を取得
async function getRecentVisits(customer, limit = 5) {
  const client = getClient();
  if (!client) return [];

  // customerが未指定 or karte_no が無ければ空配列
  const karteNo = customer && typeof customer === 'object' ? customer.karte_no : null;
  if (karteNo == null) return [];

  const { data, error } = await client
    .from('visits')
    .select('*')
    .eq('karte_no', karteNo)
    .order('start_time', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[Supabase] 来店履歴取得エラー:', error.message);
    return [];
  }
  // 旧コード互換の別名付きで返す
  return (data || []).map(v => ({
    ...v,
    visited_at: v.start_time,
    staff_name: v.main_staff,
    menu: v.treatment_detail,
    total_amount: (v.treatment_total || 0) + (v.retail_total || 0) + (v.tax_amount || 0),
  }));
}

// 顧客の購入履歴を取得（purchases テーブルは現状未作成のため空配列を返す）
async function getRecentPurchases() {
  return [];
}

// 顧客の全情報をまとめて取得
async function getCustomerProfile(identifier, type = 'phone') {
  try {
    let customer;
    if (type === 'phone') {
      customer = await findCustomerByPhone(identifier);
    } else if (type === 'line_id') {
      customer = await findCustomerByLineId(identifier);
    }

    if (!customer) return null;

    const visits = await getRecentVisits(customer);
    const purchases = await getRecentPurchases();

    return { customer, visits, purchases };
  } catch (err) {
    console.error('[Supabase] プロフィール取得エラー:', err.message);
    return null;
  }
}

// ============================================
// 会話ログ保存（conversation_logs テーブル）
// サロンモード・フリーランスモード共通
// ============================================
async function saveConversationLog(logData) {
  const client = getClient();
  if (!client) {
    console.warn('[ConversationLog] Supabase未接続 - ログ保存スキップ');
    return null;
  }

  const row = {
    salon_id: logData.salonId || process.env.SALON_ID || null,
    tenant_id: logData.tenantId,
    customer_id: logData.customerId || null,
    line_user_id: logData.lineUserId,
    customer_message: logData.customerMessage,
    ai_response: logData.aiResponse,
    is_handoff: logData.isHandoff || false,
    handoff_summary: logData.handoffSummary || null,
    created_at: logData.timestamp || new Date(),
  };

  // 新カラム対応（sender_type, message）
  if (logData.senderType) row.sender_type = logData.senderType;
  if (logData.message) row.message = logData.message;

  // ── 後方互換: 旧カラム（customer_message / ai_response）にも値を入れる ──
  // ダッシュボードや旧クエリが customer_message / ai_response を前提にしている場合の保険。
  // NOT NULL 制約解除後も、旧カラムから参照しているビューが壊れないようにする。
  if (logData.senderType === 'customer' && logData.message && row.customer_message == null) {
    row.customer_message = logData.message;
  }
  if (logData.senderType === 'ai' && logData.message && row.ai_response == null) {
    row.ai_response = logData.message;
  }

  // 画像メッセージ対応
  if (logData.messageType) row.message_type = logData.messageType;
  if (logData.imageUrl) row.image_url = logData.imageUrl;

  const { data, error } = await client
    .from('conversation_logs')
    .insert(row);

  if (error) {
    console.error('[ConversationLog] 保存エラー:', error.message);
    return null;
  }
  return data;
}

/**
 * お客様メッセージとAI応答をそれぞれ独立した sender_type 付きの行として保存する。
 * - お客様行: sender_type='customer', message=userMessage
 * - AI行:     sender_type='ai',       message=aiResponse
 *
 * 旧コードは customer_message と ai_response を1行にまとめて保存していたが、
 * 新スキーマ（sender_type + message）に揃えるためペアで2行保存する。
 * AI行は +1ms 遅延させて表示順（created_at ASC）で必ず customer の後に出るようにする。
 */
async function saveCustomerAndAiMessages({
  tenantId,
  customerId = null,
  lineUserId,
  userMessage,
  aiResponse,
  isHandoff = false,
  handoffSummary = null,
  messageType = 'text',
  imageUrl = null,
  timestamp,
}) {
  const t = timestamp instanceof Date
    ? timestamp
    : new Date(timestamp || Date.now());

  // お客様行
  if (userMessage) {
    await saveConversationLog({
      tenantId,
      customerId,
      lineUserId,
      senderType: 'customer',
      message: userMessage,
      messageType,
      imageUrl,
      timestamp: t,
    });
  }

  // AI/Bot応答行
  if (aiResponse) {
    await saveConversationLog({
      tenantId,
      customerId,
      lineUserId,
      senderType: 'ai',
      message: aiResponse,
      isHandoff,
      handoffSummary,
      timestamp: new Date(t.getTime() + 1),
    });
  }
}

// ============================================
// 画像アップロード（mycon-images バケット）
// ============================================
async function uploadImageToStorage(buffer, filename, contentType = 'image/jpeg') {
  const client = getClient();
  if (!client) {
    console.warn('[Storage] Supabase未接続 - アップロードスキップ');
    return null;
  }

  const { error } = await client.storage
    .from('mycon-images')
    .upload(filename, buffer, {
      contentType,
      upsert: false,
    });

  if (error) {
    console.error('[Storage] アップロードエラー:', error.message);
    return null;
  }

  const { data } = client.storage.from('mycon-images').getPublicUrl(filename);
  return data?.publicUrl || null;
}

// ============================================
// 監査ログ（audit_logs）— Supabase RPC: log_customer_access
// ============================================
/**
 * @param {object} params
 * @param {string} params.action     - 'customer_view' | 'ai_response' | 'staff_handoff' | 'customer_update' など
 * @param {string} [params.actor]    - 'ai' | 'staff:<name>' など。デフォルト 'ai'
 * @param {string|number} [params.customerId]
 * @param {object} [params.details]  - 任意のJSONメタデータ
 * @param {string} [params.salonId]  - 省略時は process.env.SALON_ID
 */
async function logCustomerAccess(params = {}) {
  const client = getClient();
  if (!client) return;

  const salonId = params.salonId || process.env.SALON_ID;
  if (!salonId) {
    // SALON_ID未設定環境では監査ログをスキップ（致命的にしない）
    return;
  }
  if (!params.action) return;

  try {
    const { error } = await client.rpc('log_customer_access', {
      p_salon_id: salonId,
      p_action: params.action,
      p_actor: params.actor || 'ai',
      p_customer_id: params.customerId != null ? String(params.customerId) : null,
      p_details: params.details || {},
    });
    if (error) {
      console.warn('[Audit] log_customer_access エラー:', error.message);
    }
  } catch (err) {
    console.warn('[Audit] log_customer_access 例外:', err.message);
  }
}

// line_user_id にこれまでの conversation_logs があるかチェック
async function hasPriorConversation(lineUserId) {
  const client = getClient();
  if (!client || !lineUserId) return false;

  const { count, error } = await client
    .from('conversation_logs')
    .select('*', { count: 'exact', head: true })
    .eq('line_user_id', lineUserId);

  if (error) {
    console.warn('[Supabase] 過去会話チェック失敗:', error.message);
    return false;
  }
  return (count || 0) > 0;
}

// ============================================
// 顧客名検索（紐づけ用）
// ============================================
/**
 * 名前バリエーションで顧客を検索
 *  - customer_name 完全一致
 *  - customer_name スペース除去一致
 *  - yomigana 完全一致
 *  - 姓だけ or 名だけの部分一致（customer_name / yomigana）
 * @param {string} name - お客様入力の名前
 * @param {string} [salonId] - process.env.SALON_ID にフォールバック
 * @returns {Promise<{customers: object[], matchKind: string}>}
 */
async function findCustomersByName(name, salonId) {
  const client = getClient();
  if (!client || !name) return { customers: [], matchKind: 'none' };

  const trimmed = String(name).trim();
  const noSpace = trimmed.replace(/[\s　]+/g, '');
  const sid = salonId || process.env.SALON_ID || null;

  // 1. 完全一致 / スペース除去一致 / よみがな一致 を一気にOR検索
  let q1 = client.from('customers').select('*');
  if (sid) q1 = q1.eq('salon_id', sid);
  q1 = q1.or([
    `customer_name.eq.${trimmed}`,
    `customer_name.eq.${noSpace}`,
    `yomigana.eq.${trimmed}`,
    `yomigana.eq.${noSpace}`,
  ].join(','));
  const { data: exact, error: err1 } = await q1.limit(20);
  if (err1) {
    console.warn('[Supabase] 名前検索エラー(exact):', err1.message);
  }
  if (exact && exact.length > 0) {
    return { customers: exact, matchKind: 'exact' };
  }

  // 2. 部分一致（姓 or 名 だけのケース）
  let q2 = client.from('customers').select('*');
  if (sid) q2 = q2.eq('salon_id', sid);
  q2 = q2.or([
    `customer_name.ilike.%${trimmed}%`,
    `yomigana.ilike.%${trimmed}%`,
  ].join(','));
  const { data: partial, error: err2 } = await q2.limit(20);
  if (err2) {
    console.warn('[Supabase] 名前検索エラー(partial):', err2.message);
    return { customers: [], matchKind: 'none' };
  }
  if (partial && partial.length > 0) {
    return { customers: partial, matchKind: 'partial' };
  }

  return { customers: [], matchKind: 'none' };
}

/**
 * 電話番号下4桁で顧客を絞り込む
 * @param {string} last4
 * @param {object[]} [restrictTo] - 候補がある場合はその中から絞り込む
 * @param {string} [salonId]
 */
async function findCustomersByPhoneLast4(last4, restrictTo, salonId) {
  const client = getClient();
  if (!client || !/^\d{4}$/.test(last4)) return [];

  if (restrictTo && restrictTo.length > 0) {
    return restrictTo.filter((c) => {
      const p = String(c.phone || '').replace(/\D/g, '');
      return p.endsWith(last4);
    });
  }

  const sid = salonId || process.env.SALON_ID || null;
  let q = client.from('customers').select('*').ilike('phone', `%${last4}`);
  if (sid) q = q.eq('salon_id', sid);
  const { data, error } = await q.limit(20);
  if (error) {
    console.warn('[Supabase] 電話番号下4桁検索エラー:', error.message);
    return [];
  }
  // ilike で末尾4桁マッチを保証
  return (data || []).filter((c) => {
    const p = String(c.phone || '').replace(/\D/g, '');
    return p.endsWith(last4);
  });
}

/**
 * 顧客レコードに line_id を保存（紐づけ確定）
 */
async function linkLineUserToCustomer(customerId, lineUserId) {
  const client = getClient();
  if (!client || !customerId || !lineUserId) return false;

  const { error } = await client
    .from('customers')
    .update({ line_id: lineUserId, updated_at: new Date() })
    .eq('id', customerId);

  if (error) {
    console.error('[Supabase] LINE紐づけ保存エラー:', error.message);
    return false;
  }
  return true;
}

// ============================================
// Conversation settings（AI応答ON/OFFなど）
// ============================================
async function getConversationAiEnabled(lineUserId) {
  const client = getClient();
  if (!client || !lineUserId) return true;
  const { data, error } = await client
    .from('conversation_settings')
    .select('ai_enabled')
    .eq('line_user_id', lineUserId)
    .maybeSingle();
  if (error) {
    console.warn('[ConversationSettings] 取得失敗:', error.message);
    return true;
  }
  return data ? !!data.ai_enabled : true;
}

async function setConversationAiEnabled(lineUserId, enabled, tenantId = null) {
  const client = getClient();
  if (!client || !lineUserId) return false;
  const { error } = await client
    .from('conversation_settings')
    .upsert(
      {
        line_user_id: lineUserId,
        ai_enabled: !!enabled,
        tenant_id: tenantId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'line_user_id' },
    );
  if (error) {
    console.warn('[ConversationSettings] 更新失敗:', error.message);
    return false;
  }
  return true;
}

async function getAiEnabledMap(lineUserIds) {
  const client = getClient();
  const map = new Map();
  if (!client || !Array.isArray(lineUserIds) || lineUserIds.length === 0) return map;
  const { data, error } = await client
    .from('conversation_settings')
    .select('line_user_id, ai_enabled')
    .in('line_user_id', lineUserIds);
  if (error) {
    console.warn('[ConversationSettings] 一括取得失敗:', error.message);
    return map;
  }
  for (const row of data || []) map.set(row.line_user_id, !!row.ai_enabled);
  return map;
}

module.exports = {
  findCustomerByPhone,
  findCustomerByLineId,
  getRecentVisits,
  getRecentPurchases,
  getCustomerProfile,
  saveConversationLog,
  saveCustomerAndAiMessages,
  uploadImageToStorage,
  hasPriorConversation,
  logCustomerAccess,
  findCustomersByName,
  findCustomersByPhoneLast4,
  linkLineUserToCustomer,
  getAdminClient,
  getAnonClient,
  getConversationAiEnabled,
  setConversationAiEnabled,
  getAiEnabledMap,
};
