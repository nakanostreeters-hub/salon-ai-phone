// ============================================
// supabase-client.js
// Supabase 顧客データ取得サービス
// ============================================
const { createClient } = require('@supabase/supabase-js');

let supabase = null;

function getClient() {
  if (!supabase && process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );
  }
  return supabase;
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
async function getRecentVisits(customerId, limit = 5) {
  const client = getClient();
  if (!client) return [];

  const { data, error } = await client
    .from('visits')
    .select('*')
    .eq('customer_id', customerId)
    .order('visited_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[Supabase] 来店履歴取得エラー:', error.message);
    return [];
  }
  return data || [];
}

// 顧客の購入履歴を取得
async function getRecentPurchases(customerId, limit = 5) {
  const client = getClient();
  if (!client) return [];

  const { data, error } = await client
    .from('purchases')
    .select('*')
    .eq('customer_id', customerId)
    .order('purchased_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[Supabase] 購入履歴取得エラー:', error.message);
    return [];
  }
  return data || [];
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

    const visits = await getRecentVisits(customer.id);
    const purchases = await getRecentPurchases(customer.id);

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

  const { data, error } = await client
    .from('conversation_logs')
    .insert(row);

  if (error) {
    console.error('[ConversationLog] 保存エラー:', error.message);
    return null;
  }
  return data;
}

module.exports = {
  findCustomerByPhone,
  findCustomerByLineId,
  getRecentVisits,
  getRecentPurchases,
  getCustomerProfile,
  saveConversationLog,
};
