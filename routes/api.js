// ============================================
// routes/api.js
// mycon 管理画面 API エンドポイント
// ============================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const line = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const { getTenant } = require('../config/tenants');

const router = express.Router();

// ─── Anthropic Client ───
let anthropicClient = null;
function getAnthropic() {
  if (!anthropicClient && process.env.ANTHROPIC_API_KEY) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY.trim() });
  }
  return anthropicClient;
}

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

// ─── ヘルパー: 経過時間から優先度判定 ───
function priorityFromAge(lastAt) {
  const minutes = (Date.now() - new Date(lastAt).getTime()) / 60000;
  if (minutes <= 60) return { level: 'high', label: '高', minutes: Math.round(minutes) };
  if (minutes <= 180) return { level: 'medium', label: '中', minutes: Math.round(minutes) };
  return { level: 'low', label: '低', minutes: Math.round(minutes) };
}

// ─── ヘルパー: AI返信案を生成 ───
async function generateReplySuggestion(client, ctx) {
  const history = (ctx.recentLogs || [])
    .slice()
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .slice(-8)
    .map(l => {
      const isCustomer = l.sender_type === 'customer'
        || (!l.sender_type && l.customer_message && !/^（.+）$/.test(l.customer_message));
      const text = (l.message || l.customer_message || l.ai_response || '').trim();
      if (!text) return null;
      return { role: isCustomer ? 'user' : 'assistant', content: text };
    })
    .filter(Boolean);

  if (history.length === 0 || history[history.length - 1].role !== 'user') {
    return null;
  }

  const customerLine = ctx.customerName
    ? `お客様情報：${ctx.customerName}様`
    : 'お客様情報：（新規／不明）';

  const system = `あなたは美容室「${process.env.SALON_NAME || 'PREMIER MODELS 中野'}」のスタッフ用AIアシスタントです。
お客様への返信文の「下書き案」を1つだけ提案してください。
コンセプトは「AIっぽさを消した、人間の美容師のような自然な接客」。ちょっと雑なくらいが一番自然。

トーン：
- フレンドリー寄りの敬語（硬すぎない）。「〜くださいませ」のような硬い言い回しは避ける
- 1〜2文、合計3行以内
- 絵文字は0〜1個（多くて1個）、前置き不要、本文のみ
- 毎回同じ言い回しにしない（語尾・冒頭にバリエーション）

ルール：
- 質問は1つまで。質問攻めにしない
- 来店日時の確定や個人情報の断定はしない（必要なら確認質問）
- 売り込みすぎない
- 引き継ぎが必要な文脈では「担当者に引き継ぎます」のような硬い表現ではなく
  「一度担当の者にも確認しますね😊」のような柔らかい表現にする
- 営業時間外の文脈なら「ご連絡ありがとうございます！営業時間外のため、確認して改めてご案内しますね😊」ベースで

${customerLine}
直近の会話履歴を踏まえ、最新のお客様メッセージへの返信案だけを出力してください。`;

  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    system,
    messages: history,
  });
  return (res.content?.[0]?.text || '').trim();
}

// ─── ヘルパー: 来店履歴から施術リスクを判定 ───
// visits: [{ menu, visited_at, ... }]
function analyzeTreatmentRisks(visits) {
  const flags = {
    hasStraightening: false,
    hasBleach: false,
    recentHeavy: false,
    warnings: [],
  };
  if (!visits || visits.length === 0) return flags;

  const now = Date.now();
  const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
  const STRAIGHT_RE = /縮毛矯正|ストレート|ストパ/;
  const BLEACH_RE = /ブリーチ|脱色|ダブルカラー|bleach/i;

  let lastStraightAt = null;
  let lastBleachAt = null;

  for (const v of visits) {
    const menu = v.menu || '';
    const at = v.visited_at ? new Date(v.visited_at).getTime() : 0;
    if (STRAIGHT_RE.test(menu)) {
      flags.hasStraightening = true;
      if (!lastStraightAt || at > lastStraightAt) lastStraightAt = at;
    }
    if (BLEACH_RE.test(menu)) {
      flags.hasBleach = true;
      if (!lastBleachAt || at > lastBleachAt) lastBleachAt = at;
    }
  }

  if (flags.hasStraightening) {
    flags.warnings.push({
      level: 'caution',
      code: 'straightening_history',
      text: 'カラー提案時は薬剤選定に注意（縮毛矯正履歴あり）',
    });
  }
  if (flags.hasBleach) {
    flags.warnings.push({
      level: 'danger',
      code: 'bleach_damage',
      text: 'ブリーチ履歴あり — ダメージ配慮が必要',
    });
  }
  const latestHeavy = Math.max(lastStraightAt || 0, lastBleachAt || 0);
  if (latestHeavy && now - latestHeavy < ONE_MONTH_MS) {
    flags.recentHeavy = true;
    flags.warnings.push({
      level: 'danger',
      code: 'recent_heavy',
      text: '直近1ヶ月以内に高負荷メニュー施術 — 追加施術は慎重に',
    });
  }

  return flags;
}

// ─── ヘルパー: 会話ログから接客タイプを判定 ───
// logs は created_at 昇順推奨（内部で並び替え）
function analyzeServiceStyle(logs) {
  if (!logs || logs.length === 0) {
    return { type: 'unknown', label: '未分析', advice: 'データ不足：通常の接客で様子を見てください' };
  }

  const sorted = [...logs].sort(
    (a, b) => new Date(a.created_at) - new Date(b.created_at)
  );

  // 顧客発話のみ抽出
  const customerMsgs = sorted.filter(l => {
    if (l.sender_type === 'customer') return true;
    if (l.sender_type) return false; // staff/system は除外
    // 旧形式: customer_message が「（…）」以外
    return l.customer_message && !/^（.+）$/.test(l.customer_message);
  });

  if (customerMsgs.length === 0) {
    return { type: 'unknown', label: '未分析', advice: 'データ不足：通常の接客で様子を見てください' };
  }

  // 平均メッセージ長
  const totalLen = customerMsgs.reduce((s, l) => {
    const txt = l.message || l.customer_message || '';
    return s + txt.length;
  }, 0);
  const avgLen = totalLen / customerMsgs.length;

  // 返信速度：直前の AI 応答(ai_response あり)から次の顧客発話までの時間
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const prevIsAi = prev.ai_response || prev.sender_type === 'ai' || prev.sender_type === 'staff';
    const currIsCustomer =
      curr.sender_type === 'customer' ||
      (!curr.sender_type && curr.customer_message && !/^（.+）$/.test(curr.customer_message));
    if (prevIsAi && currIsCustomer) {
      const gap = (new Date(curr.created_at) - new Date(prev.created_at)) / 1000; // 秒
      if (gap >= 0 && gap < 24 * 3600) gaps.push(gap);
    }
  }
  const medianGap =
    gaps.length > 0
      ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)]
      : null;

  // 判定: 短文 & 即レス → 即決型
  const quick = avgLen < 20 && (medianGap === null || medianGap < 300);
  if (quick) {
    return {
      type: 'quick',
      label: '即決型',
      advice: '2択提案が効果的',
      avgLen: Math.round(avgLen),
      medianReplySec: medianGap,
      sampleSize: customerMsgs.length,
    };
  }
  return {
    type: 'careful',
    label: '慎重型',
    advice: '写真を見せながら丁寧に説明',
    avgLen: Math.round(avgLen),
    medianReplySec: medianGap,
    sampleSize: customerMsgs.length,
  };
}

// ─── ヘルパー: 会話サマリー（詳細画面用） ───
function summarizeConversation(logs) {
  if (!logs || logs.length === 0) {
    return { totalMessages: 0, customerMessages: 0, aiMessages: 0, handoffCount: 0, keywords: [], firstAt: null, lastAt: null };
  }
  let customerMessages = 0;
  let aiMessages = 0;
  let handoffCount = 0;
  const textBuf = [];
  for (const l of logs) {
    if (l.is_handoff) handoffCount++;
    const isCustomer =
      l.sender_type === 'customer' ||
      (!l.sender_type && l.customer_message && !/^（.+）$/.test(l.customer_message));
    if (isCustomer) {
      customerMessages++;
      textBuf.push(l.message || l.customer_message || '');
    } else if (l.ai_response || l.sender_type === 'ai') {
      aiMessages++;
    }
  }
  // 簡易キーワード抽出: 2文字以上の頻出語（カタカナ/漢字）
  const joined = textBuf.join(' ');
  const tokens = joined.match(/[ァ-ヴー]{2,}|[一-龥]{2,}/g) || [];
  const freq = {};
  for (const t of tokens) freq[t] = (freq[t] || 0) + 1;
  const keywords = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word, count]) => ({ word, count }));

  const sorted = [...logs].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return {
    totalMessages: logs.length,
    customerMessages,
    aiMessages,
    handoffCount,
    keywords,
    firstAt: sorted[0].created_at,
    lastAt: sorted[sorted.length - 1].created_at,
  };
}

// ─── ヘルパー: AI提案の検出 (リタッチ/離反/単価UP) ───
const COLOR_RE = /カラー|ヘアカラー|リタッチ|color/i;
const CUT_RE = /カット|cut/i;
const NON_CUT_RE = /カラー|パーマ|縮毛|ストレート|ストパ|トリートメント|スパ|ブリーチ|エクステ/;
const DAY_MS = 24 * 60 * 60 * 1000;

function detectSuggestions(customer, visits) {
  const name = getCustomerName(customer) || 'お客様';
  const now = Date.now();
  const result = { retouch: null, churn: null, upsell: null };

  const sorted = [...(visits || [])].sort(
    (a, b) => new Date(b.visited_at) - new Date(a.visited_at)
  );

  const lastColor = sorted.find(v => COLOR_RE.test(v.menu || ''));
  if (lastColor) {
    const days = Math.floor((now - new Date(lastColor.visited_at)) / DAY_MS);
    if (days >= 45) {
      result.retouch = {
        id: customer.id, name, phone: customer.phone, lineId: customer.line_id,
        daysSince: days,
        lastColorAt: lastColor.visited_at,
        lastMenu: lastColor.menu,
      };
    }
  }

  if (sorted.length >= 3) {
    const intervals = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const d = (new Date(sorted[i].visited_at) - new Date(sorted[i + 1].visited_at)) / DAY_MS;
      if (d > 0) intervals.push(d);
    }
    if (intervals.length) {
      const mid = intervals.slice().sort((a, b) => a - b);
      const median = mid[Math.floor(mid.length / 2)];
      const daysSinceLast = (now - new Date(sorted[0].visited_at)) / DAY_MS;
      if (median > 0 && daysSinceLast > median * 1.5 && daysSinceLast > 30) {
        result.churn = {
          id: customer.id, name, phone: customer.phone, lineId: customer.line_id,
          daysSince: Math.floor(daysSinceLast),
          medianInterval: Math.floor(median),
          ratio: Number((daysSinceLast / median).toFixed(1)),
        };
      }
    }
  }

  if (sorted.length >= 3) {
    const cutOnly = sorted.every(v => {
      const m = v.menu || '';
      return CUT_RE.test(m) && !NON_CUT_RE.test(m);
    });
    if (cutOnly) {
      const total = sorted.reduce((s, v) => s + (v.total_amount || 0), 0);
      result.upsell = {
        id: customer.id, name, phone: customer.phone, lineId: customer.line_id,
        visitCount: sorted.length,
        avgSpend: Math.round(total / sorted.length),
      };
    }
  }

  return result;
}

const suggestionCache = new Map();

function buildSuggestionPrompt(type, s) {
  const salon = process.env.SALON_NAME || 'PREMIER MODELS 中野';
  if (type === 'retouch') {
    return `あなたは美容室「${salon}」のスタッフです。前回カラーから${s.daysSince}日経過したお客様「${s.name}様」に、リタッチ来店を促すLINEメッセージを作成してください。
条件:
- 2〜3文、150文字以内
- 押し付けがましくない、丁寧で温かい口調
- 根元のリタッチや色持ちに軽く触れる
- 絵文字は使わない
メッセージ本文のみ出力（前置き・引用符・署名なし）。`;
  }
  if (type === 'churn') {
    return `あなたは美容室「${salon}」のスタッフです。通常${s.medianInterval}日間隔で来店されていた常連の「${s.name}様」が、前回来店から${s.daysSince}日空いています。気遣いを感じる、さりげない再来店のお誘いLINEを作成してください。
条件:
- 2〜3文、150文字以内
- 営業感を出さず、気にかけている気持ちを伝える
- お体やご都合を気遣う一言を添える
- 絵文字は使わない
メッセージ本文のみ出力（前置き・引用符・署名なし）。`;
  }
  return `あなたは美容室「${salon}」のスタッフです。「${s.name}様」は${s.visitCount}回来店の常連ですが、これまでカットのみのご利用です。次回来店時に別メニューも体験いただくきっかけとなるLINEメッセージを作成してください。
条件:
- 2〜3文、150文字以内
- 押し売りにならない、提案・ご相談のトーン
- 具体的なメニューを1つだけ挙げる（例: トリートメント／カラー）
- 絵文字は使わない
メッセージ本文のみ出力（前置き・引用符・署名なし）。`;
}

async function generateSuggestionMessage(type, s) {
  const cacheKey = `${type}:${s.id}:${s.daysSince ?? ''}:${s.visitCount ?? ''}`;
  if (suggestionCache.has(cacheKey)) return suggestionCache.get(cacheKey);

  const client = getAnthropic();
  if (!client) return null;

  try {
    const res = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      messages: [{ role: 'user', content: buildSuggestionPrompt(type, s) }],
    });
    const text = (res.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();
    suggestionCache.set(cacheKey, text);
    return text;
  } catch (err) {
    console.error('[suggestion generate] error:', err.message);
    return null;
  }
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
        salon_id: process.env.SALON_ID || null,
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

    // 監査ログ: スタッフ返信をstaff_handoffとして記録
    const staffName = req.user?.user_metadata?.name || req.user?.email || 'unknown';
    try {
      await req.supabase.rpc('log_customer_access', {
        p_salon_id: process.env.SALON_ID || tenant.id,
        p_action: 'staff_handoff',
        p_actor: `staff:${staffName}`,
        p_customer_id: null,
        p_details: { lineUserId: req.params.lineUserId, context: 'chat_reply' },
      });
    } catch (auditErr) {
      console.warn('[Audit] スタッフ返信ログ失敗:', auditErr.message);
    }

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

    // 各顧客の会話ログを取得 → 最終メッセージ & 接客タイプ判定
    const customers = data || [];
    const customerIds = customers.map(c => c.id).filter(Boolean);
    let lastMsgMap = {};
    let logsByCustomer = {};
    let visitsByCustomer = {};
    if (customerIds.length) {
      const { data: visitsAll } = await req.supabase
        .from('visits')
        .select('customer_id, menu, visited_at')
        .in('customer_id', customerIds)
        .order('visited_at', { ascending: false });
      for (const v of visitsAll || []) {
        (visitsByCustomer[v.customer_id] = visitsByCustomer[v.customer_id] || []).push(v);
      }
    }
    if (customerIds.length) {
      const { data: logs } = await req.supabase
        .from('conversation_logs')
        .select('customer_id, created_at, message, customer_message, ai_response, sender_type, is_handoff')
        .in('customer_id', customerIds)
        .order('created_at', { ascending: false });
      for (const l of logs || []) {
        if (!lastMsgMap[l.customer_id]) {
          lastMsgMap[l.customer_id] = {
            at: l.created_at,
            text: l.message || l.customer_message,
          };
        }
        (logsByCustomer[l.customer_id] = logsByCustomer[l.customer_id] || []).push(l);
      }
    }

    const enriched = customers.map(c => {
      const style = analyzeServiceStyle(logsByCustomer[c.id] || []);
      const riskFlags = analyzeTreatmentRisks(visitsByCustomer[c.id] || []);
      return {
        ...c,
        last_message_at: lastMsgMap[c.id]?.at || null,
        last_message_text: lastMsgMap[c.id]?.text || null,
        service_style: style,
        risk_flags: riskFlags,
      };
    });

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

    const serviceStyle = analyzeServiceStyle(conversationLogs);
    const conversationSummary = summarizeConversation(conversationLogs);
    const riskFlags = analyzeTreatmentRisks(visits || []);

    res.json({
      customer,
      visits: visits || [],
      purchases: purchases || [],
      conversationLogs,
      serviceStyle,
      conversationSummary,
      riskFlags,
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

// GET /api/dashboard/ai-suggestions - 「今すぐ返信すべき人」AI返信案つき
router.get('/dashboard/ai-suggestions', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 5, 10);

    // 直近のログを広めに取得
    const { data: logs, error } = await req.supabase
      .from('conversation_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(300);
    if (error) throw error;

    // line_user_id ごとに最新ログを把握
    const latestByUser = new Map();
    const logsByUser = new Map();
    for (const log of logs || []) {
      if (!latestByUser.has(log.line_user_id)) {
        latestByUser.set(log.line_user_id, log);
      }
      if (!logsByUser.has(log.line_user_id)) logsByUser.set(log.line_user_id, []);
      logsByUser.get(log.line_user_id).push(log);
    }

    // 最新が customer 発信 = まだスタッフ返信がない
    const candidates = [...latestByUser.values()]
      .filter(l => {
        const isCustomer = l.sender_type === 'customer'
          || (!l.sender_type && l.customer_message && !/^（.+）$/.test(l.customer_message));
        return isCustomer;
      })
      .map(l => ({
        log: l,
        priority: priorityFromAge(l.created_at),
      }))
      .sort((a, b) => {
        // 優先度 high > medium > low、同じなら新しい順
        const order = { high: 0, medium: 1, low: 2 };
        const d = order[a.priority.level] - order[b.priority.level];
        if (d !== 0) return d;
        return new Date(b.log.created_at) - new Date(a.log.created_at);
      })
      .slice(0, limit);

    // 顧客名を解決
    const customerIds = [...new Set(candidates.map(c => c.log.customer_id).filter(Boolean))];
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

    // AI返信案を並列生成
    const anthropic = getAnthropic();
    const results = await Promise.all(candidates.map(async ({ log, priority }) => {
      const customerName = nameMap[log.customer_id] || null;
      let aiSuggestion = null;
      let aiError = null;
      if (anthropic) {
        try {
          aiSuggestion = await generateReplySuggestion(anthropic, {
            customerName,
            recentLogs: logsByUser.get(log.line_user_id) || [],
          });
        } catch (e) {
          aiError = e.message || 'AI生成に失敗';
        }
      } else {
        aiError = 'ANTHROPIC_API_KEY 未設定';
      }
      return {
        lineUserId: log.line_user_id,
        customerId: log.customer_id,
        customerName,
        lastMessage: log.message || log.customer_message || '',
        lastAt: log.created_at,
        priority,
        aiSuggestion,
        aiError,
      };
    }));

    res.json({ suggestions: results });
  } catch (err) {
    console.error('[API /dashboard/ai-suggestions] Error:', err.message);
    res.status(500).json({ error: 'AI提案の取得に失敗しました' });
  }
});

// GET /api/dashboard/proactive-suggestions - リタッチ／離反／単価UP の先回り提案
router.get('/dashboard/proactive-suggestions', authMiddleware, async (req, res) => {
  try {
    const perType = Math.min(parseInt(req.query.perType, 10) || 5, 10);

    const { data: customers, error: custErr } = await req.supabase
      .from('customers')
      .select('id, customer_name, name, phone, line_id, last_visit_at, visit_count')
      .limit(500);
    if (custErr) throw custErr;

    const customerIds = (customers || []).map(c => c.id).filter(Boolean);
    let visitsByCustomer = {};
    if (customerIds.length) {
      const { data: visitsAll } = await req.supabase
        .from('visits')
        .select('customer_id, menu, visited_at, total_amount')
        .in('customer_id', customerIds)
        .order('visited_at', { ascending: false });
      for (const v of visitsAll || []) {
        (visitsByCustomer[v.customer_id] = visitsByCustomer[v.customer_id] || []).push(v);
      }
    }

    const retouch = [], churn = [], upsell = [];
    for (const c of customers || []) {
      const s = detectSuggestions(c, visitsByCustomer[c.id] || []);
      if (s.retouch) retouch.push(s.retouch);
      if (s.churn) churn.push(s.churn);
      if (s.upsell) upsell.push(s.upsell);
    }

    retouch.sort((a, b) => b.daysSince - a.daysSince);
    churn.sort((a, b) => b.ratio - a.ratio);
    upsell.sort((a, b) => b.visitCount - a.visitCount);

    const topRetouch = retouch.slice(0, perType);
    const topChurn = churn.slice(0, perType);
    const topUpsell = upsell.slice(0, perType);

    await Promise.all([
      ...topRetouch.map(async s => { s.message = await generateSuggestionMessage('retouch', s); }),
      ...topChurn.map(async s => { s.message = await generateSuggestionMessage('churn', s); }),
      ...topUpsell.map(async s => { s.message = await generateSuggestionMessage('upsell', s); }),
    ]);

    res.json({
      retouch: topRetouch,
      churn: topChurn,
      upsell: topUpsell,
      counts: { retouch: retouch.length, churn: churn.length, upsell: upsell.length },
      aiEnabled: !!getAnthropic(),
    });
  } catch (err) {
    console.error('[API /dashboard/proactive-suggestions] Error:', err.message);
    res.status(500).json({ error: '先回り提案の取得に失敗しました' });
  }
});

module.exports = router;
