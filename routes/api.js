// ============================================
// routes/api.js
// mycon 管理画面 API エンドポイント
// ============================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const line = require('@line/bot-sdk');
const { getTenant } = require('../config/tenants');

const router = express.Router();

// ─── Supabase Admin Client（サーバー側） ───
let supabase = null;
function getSupabase() {
  if (!supabase && process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  }
  return supabase;
}

// ─── テナント別 LINE Client キャッシュ ───
const lineClients = new Map();
function getLineClientForTenant(tenant) {
  if (!tenant || !tenant.lineChannelAccessToken) return null;
  if (lineClients.has(tenant.id)) return lineClients.get(tenant.id);
  const client = new line.messagingApi.MessagingApiClient({
    channelAccessToken: tenant.lineChannelAccessToken,
  });
  lineClients.set(tenant.id, client);
  return client;
}

// ─── ヘルパー: 顧客名を取得 ───
function getCustomerName(row) {
  return row.customer_name || row.name || '';
}

// ============================================
// 認証ミドルウェア
// ============================================
async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sb = getSupabase();
  if (!sb) {
    return res.status(503).json({ error: 'Database unavailable' });
  }

  try {
    const { data: { user }, error } = await sb.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    req.user = user;
    req.supabase = sb;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Authentication failed' });
  }
}

// ============================================
// 認証 API
// ============================================

// POST /api/auth/login
router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'メールアドレスとパスワードを入力してください' });
  }

  const sb = getSupabase();
  if (!sb) {
    return res.status(503).json({ error: 'データベースに接続できません' });
  }

  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      return res.status(401).json({ error: error.message });
    }
    res.json({
      user: data.user,
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'ログインに失敗しました' });
  }
});

// POST /api/auth/logout
router.post('/auth/logout', authMiddleware, async (req, res) => {
  try {
    await req.supabase.auth.signOut();
    res.json({ success: true });
  } catch (err) {
    res.json({ success: true });
  }
});

// ============================================
// チャット API
// ============================================

// GET /api/chats - 全チャット一覧（顧客ごとにグループ化）
router.get('/chats', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('conversation_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) throw error;

    // LINE user IDごとにグループ化
    const chatMap = new Map();
    for (const log of data) {
      const key = log.line_user_id;
      if (!chatMap.has(key)) {
        chatMap.set(key, {
          lineUserId: key,
          tenantId: log.tenant_id,
          customerId: log.customer_id,
          lastMessage: log.customer_message,
          lastAiResponse: log.ai_response,
          lastAt: log.created_at,
          isHandoff: log.is_handoff,
          messageCount: 0,
          hasHandoff: false,
        });
      }
      const chat = chatMap.get(key);
      chat.messageCount++;
      if (log.is_handoff) chat.hasHandoff = true;
    }

    // 顧客名を取得（customer_name カラム対応）
    const customerIds = [...new Set([...chatMap.values()].map(c => c.customerId).filter(Boolean))];
    let customerNames = {};
    if (customerIds.length > 0) {
      const { data: customers } = await req.supabase
        .from('customers')
        .select('id, customer_name, name')
        .in('id', customerIds);
      if (customers) {
        customerNames = Object.fromEntries(
          customers.map(c => [c.id, getCustomerName(c)])
        );
      }
    }

    const chats = [...chatMap.values()].map(chat => ({
      ...chat,
      customerName: customerNames[chat.customerId] || null,
      status: chat.hasHandoff ? 'handoff' : 'ai_active',
    }));

    chats.sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));

    res.json({ chats });
  } catch (err) {
    console.error('[API /chats] Error:', err.message);
    res.status(500).json({ error: 'チャットの取得に失敗しました' });
  }
});

// GET /api/chats/:lineUserId - 特定チャットの全メッセージ
router.get('/chats/:lineUserId', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('conversation_logs')
      .select('*')
      .eq('line_user_id', req.params.lineUserId)
      .order('created_at', { ascending: true });

    if (error) throw error;

    // 顧客情報も取得
    let customer = null;
    if (data.length > 0 && data[0].customer_id) {
      const { data: cust } = await req.supabase
        .from('customers')
        .select('*')
        .eq('id', data[0].customer_id)
        .single();
      customer = cust;
    }

    // 来店履歴
    let visits = [];
    if (customer) {
      const { data: v } = await req.supabase
        .from('visits')
        .select('*')
        .eq('customer_id', customer.id)
        .order('visited_at', { ascending: false })
        .limit(10);
      visits = v || [];
    }

    res.json({ messages: data, customer, visits });
  } catch (err) {
    console.error('[API /chats/:id] Error:', err.message);
    res.status(500).json({ error: 'メッセージの取得に失敗しました' });
  }
});

// POST /api/chats/:lineUserId/reply - スタッフ返信（→LINE送信+DB保存）
router.post('/chats/:lineUserId/reply', authMiddleware, async (req, res) => {
  const { message, tenantId } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'メッセージを入力してください' });
  }

  const tenant = getTenant(tenantId || 'premier-models');
  if (!tenant) {
    return res.status(404).json({ error: 'テナントが見つかりません' });
  }

  try {
    const lineClient = getLineClientForTenant(tenant);
    if (lineClient) {
      await lineClient.pushMessage({
        to: req.params.lineUserId,
        messages: [{ type: 'text', text: message }],
      });
    }

    const { error } = await req.supabase
      .from('conversation_logs')
      .insert({
        tenant_id: tenant.id,
        line_user_id: req.params.lineUserId,
        customer_message: '（スタッフ返信）',
        ai_response: message,
        sender_type: 'staff',
        message: message,
        is_handoff: false,
        created_at: new Date(),
      });

    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error('[API /chats/reply] Error:', err.message);
    res.status(500).json({ error: '送信に失敗しました' });
  }
});

// ============================================
// 顧客 API
// ============================================

// GET /api/customers - 顧客一覧
router.get('/customers', authMiddleware, async (req, res) => {
  try {
    const { search, segment, sort, order, limit, offset } = req.query;

    let query = req.supabase
      .from('customers')
      .select('*', { count: 'exact' });

    // 検索（customer_name, yomigana, phone で部分一致）
    if (search) {
      query = query.or(`customer_name.ilike.%${search}%,yomigana.ilike.%${search}%,phone.ilike.%${search}%`);
    }

    // セグメント
    if (segment && segment !== 'all') {
      query = query.eq('segment', segment);
    }

    // ソート
    const sortField = sort || 'created_at';
    const sortOrder = order === 'asc' ? true : false;
    query = query.order(sortField, { ascending: sortOrder });

    // ページネーション
    const lim = parseInt(limit) || 50;
    const off = parseInt(offset) || 0;
    query = query.range(off, off + lim - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    // 各顧客の最新 conversation_logs タイムスタンプを紐付け
    const customers = data || [];
    const customerIds = customers.map(c => c.id).filter(Boolean);
    let lastMsgMap = {};
    if (customerIds.length) {
      const { data: logs } = await req.supabase
        .from('conversation_logs')
        .select('customer_id, created_at, message, customer_message')
        .in('customer_id', customerIds)
        .order('created_at', { ascending: false });
      for (const l of logs || []) {
        if (!lastMsgMap[l.customer_id]) {
          lastMsgMap[l.customer_id] = {
            at: l.created_at,
            text: l.message || l.customer_message,
          };
        }
      }
    }

    const enriched = customers.map(c => ({
      ...c,
      last_message_at: lastMsgMap[c.id]?.at || null,
      last_message_text: lastMsgMap[c.id]?.text || null,
    }));

    res.json({ customers: enriched, total: count || 0 });
  } catch (err) {
    console.error('[API /customers] Error:', err.message);
    res.status(500).json({ error: '顧客の取得に失敗しました' });
  }
});

// GET /api/customers/:id - 顧客詳細
router.get('/customers/:id', authMiddleware, async (req, res) => {
  try {
    const { data: customer, error } = await req.supabase
      .from('customers')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;

    // 来店履歴
    const { data: visits } = await req.supabase
      .from('visits')
      .select('*')
      .eq('customer_id', req.params.id)
      .order('visited_at', { ascending: false })
      .limit(20);

    // 購入履歴
    const { data: purchases } = await req.supabase
      .from('purchases')
      .select('*')
      .eq('customer_id', req.params.id)
      .order('purchased_at', { ascending: false })
      .limit(20);

    // 会話ログ
    let conversationLogs = [];
    if (customer.line_id) {
      const { data: logs } = await req.supabase
        .from('conversation_logs')
        .select('*')
        .eq('line_user_id', customer.line_id)
        .order('created_at', { ascending: false })
        .limit(50);
      conversationLogs = logs || [];
    }

    res.json({
      customer,
      visits: visits || [],
      purchases: purchases || [],
      conversationLogs,
    });
  } catch (err) {
    console.error('[API /customers/:id] Error:', err.message);
    res.status(500).json({ error: '顧客情報の取得に失敗しました' });
  }
});

// ============================================
// ダッシュボード API
// ============================================

// GET /api/dashboard - KPIデータ
router.get('/dashboard', authMiddleware, async (req, res) => {
  try {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const monthStart = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;

    // 本日の来店数
    const { count: todayVisits } = await req.supabase
      .from('visits')
      .select('*', { count: 'exact', head: true })
      .gte('visited_at', todayStr)
      .lt('visited_at', todayStr + 'T23:59:59');

    // 本日の売上
    const { data: todaySalesData } = await req.supabase
      .from('visits')
      .select('total_amount')
      .gte('visited_at', todayStr)
      .lt('visited_at', todayStr + 'T23:59:59');
    const todaySales = (todaySalesData || []).reduce((sum, v) => sum + (v.total_amount || 0), 0);

    // 月間売上
    const { data: monthSalesData } = await req.supabase
      .from('visits')
      .select('total_amount')
      .gte('visited_at', monthStart);
    const monthSales = (monthSalesData || []).reduce((sum, v) => sum + (v.total_amount || 0), 0);

    // 顧客数
    const { count: totalCustomers } = await req.supabase
      .from('customers')
      .select('*', { count: 'exact', head: true });

    // 本日の問い合わせ数（conversation_logs ユニーク顧客数）
    const { data: todayLogs } = await req.supabase
      .from('conversation_logs')
      .select('line_user_id, created_at')
      .gte('created_at', todayStr)
      .lt('created_at', todayStr + 'T23:59:59');
    const todayInquiries = new Set((todayLogs || []).map(l => l.line_user_id)).size;
    const todayMessages = (todayLogs || []).length;

    // セグメント分布（動的計算）
    // customers テーブルから全顧客の来店情報を取得
    const { data: allCustomers } = await req.supabase
      .from('customers')
      .select('id, segment, visit_count, last_visit_at');

    const segments = { vip: 0, regular: 0, churn_risk: 0, new: 0, unknown: 0 };
    const now = Date.now();
    const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

    (allCustomers || []).forEach(c => {
      // segment カラムがある場合はそれを使う
      if (c.segment && segments[c.segment] !== undefined) {
        segments[c.segment]++;
        return;
      }

      // segment がない場合は来店回数・最終来店日から判定
      const visitCount = c.visit_count || 0;
      const lastVisit = c.last_visit_at ? new Date(c.last_visit_at).getTime() : 0;
      const daysSinceLastVisit = lastVisit ? (now - lastVisit) / (24 * 60 * 60 * 1000) : Infinity;

      if (daysSinceLastVisit > 60) {
        segments.churn_risk++;
      } else if (visitCount >= 10) {
        segments.vip++;
      } else if (visitCount >= 3) {
        segments.regular++;
      } else if (visitCount <= 1) {
        segments.new++;
      } else {
        segments.unknown++;
      }
    });

    // 0のセグメントを除外
    const filteredSegments = {};
    for (const [k, v] of Object.entries(segments)) {
      if (v > 0) filteredSegments[k] = v;
    }

    res.json({
      todayVisits: todayVisits || 0,
      todaySales,
      monthSales,
      totalCustomers: totalCustomers || 0,
      todayInquiries,
      todayMessages,
      segments: filteredSegments,
    });
  } catch (err) {
    console.error('[API /dashboard] Error:', err.message);
    res.status(500).json({ error: 'ダッシュボードの取得に失敗しました' });
  }
});

// GET /api/dashboard/staff - スタッフ実績
router.get('/dashboard/staff', authMiddleware, async (req, res) => {
  try {
    const today = new Date();
    const monthStart = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;

    const { data: visits } = await req.supabase
      .from('visits')
      .select('staff_name, total_amount')
      .gte('visited_at', monthStart);

    const staffMap = {};
    (visits || []).forEach(v => {
      const name = v.staff_name || '未設定';
      if (!staffMap[name]) {
        staffMap[name] = { name, visitCount: 0, sales: 0 };
      }
      staffMap[name].visitCount++;
      staffMap[name].sales += v.total_amount || 0;
    });

    const staffStats = Object.values(staffMap).sort((a, b) => b.sales - a.sales);
    res.json({ staff: staffStats });
  } catch (err) {
    console.error('[API /dashboard/staff] Error:', err.message);
    res.status(500).json({ error: 'スタッフ実績の取得に失敗しました' });
  }
});

// GET /api/dashboard/unanswered - 未対応の最新メッセージ（is_handoff=true 以降、
// スタッフ返信がまだ無い、または最新10件）
router.get('/dashboard/unanswered', authMiddleware, async (req, res) => {
  try {
    // 最新の会話ログから、line_user_id ごとの最終メッセージを取得
    const { data: logs } = await req.supabase
      .from('conversation_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);

    // line_user_id ごとに最新1件だけ
    const latestByUser = new Map();
    for (const log of logs || []) {
      if (!latestByUser.has(log.line_user_id)) {
        latestByUser.set(log.line_user_id, log);
      }
    }

    // 最終が customer 発信 or is_handoff のものを未対応扱い
    const unanswered = [...latestByUser.values()].filter(l => {
      if (l.sender_type === 'staff') return false;
      if (l.sender_type === 'customer') return true;
      if (l.is_handoff) return true;
      // sender_type がない既存データ：AI応答があれば対応済み扱い（customer発のみ未対応）
      return l.sender_type === 'customer';
    }).slice(0, 10);

    // 顧客名を紐付け
    const customerIds = [...new Set(unanswered.map(l => l.customer_id).filter(Boolean))];
    let nameMap = {};
    if (customerIds.length) {
      const { data: customers } = await req.supabase
        .from('customers')
        .select('id, customer_name, name')
        .in('id', customerIds);
      if (customers) {
        nameMap = Object.fromEntries(customers.map(c => [c.id, getCustomerName(c)]));
      }
    }

    res.json({
      unanswered: unanswered.map(l => ({
        lineUserId: l.line_user_id,
        customerId: l.customer_id,
        customerName: nameMap[l.customer_id] || null,
        lastMessage: l.message || l.customer_message,
        lastAt: l.created_at,
        isHandoff: l.is_handoff,
      })),
    });
  } catch (err) {
    console.error('[API /dashboard/unanswered] Error:', err.message);
    res.status(500).json({ error: '未対応メッセージの取得に失敗しました' });
  }
});

// GET /api/dashboard/alerts - 離反リスクアラート
router.get('/dashboard/alerts', authMiddleware, async (req, res) => {
  try {
    // 1. segment が churn_risk の顧客
    const { data: segmentRisk } = await req.supabase
      .from('customers')
      .select('id, customer_name, name, phone, last_visit_at, segment')
      .eq('segment', 'churn_risk')
      .order('last_visit_at', { ascending: true })
      .limit(20);

    // 2. segment がなくても最終来店から60日以上経過した顧客
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const { data: dateRisk } = await req.supabase
      .from('customers')
      .select('id, customer_name, name, phone, last_visit_at, segment')
      .lt('last_visit_at', sixtyDaysAgo)
      .neq('segment', 'churn_risk') // 重複を避ける
      .order('last_visit_at', { ascending: true })
      .limit(20);

    // マージして重複排除
    const seen = new Set();
    const alerts = [];
    for (const c of [...(segmentRisk || []), ...(dateRisk || [])]) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      alerts.push({
        ...c,
        customer_name: getCustomerName(c),
      });
    }

    // 最終来店が古い順にソート
    alerts.sort((a, b) => new Date(a.last_visit_at || 0) - new Date(b.last_visit_at || 0));

    res.json({ alerts: alerts.slice(0, 20) });
  } catch (err) {
    console.error('[API /dashboard/alerts] Error:', err.message);
    res.status(500).json({ error: '離反リスクアラートの取得に失敗しました' });
  }
});

module.exports = router;
