// ============================================
// routes/line.js
// LINE Webhook エンドポイント（AIカウンセリング中継）
// Slack担当別振り分け + スタッフ返信→LINE
// ============================================

const express = require('express');
const crypto = require('crypto');
const line = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const { WebClient } = require('@slack/web-api');

const {
  getOrCreateSession,
  addMessage,
  setStatus,
  setDisplayName,
} = require('../services/lineCounselingSession');
const { buildLineCounselingPrompt } = require('../prompts/lineCounseling');
const { buildFreelanceCounselingPrompt } = require('../prompts/freelanceCounseling');
const { findStaffByName } = require('../config/staff');
const { getTenant } = require('../config/tenants');
const { getCustomerProfile, saveConversationLog, uploadImageToStorage } = require('../supabase-client');
const { buildKarteContext } = require('../ai-receptionist');
const { CHANNEL_ALL, CHANNEL_NEW, getChannelForStylist } = require('../config/slackChannels');

const router = express.Router();

// ─── 設定 ───
const LINE_CONFIG = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET || '',
};

const KARUTEKUN_WEBHOOK_URL = process.env.KARUTEKUN_WEBHOOK_URL || 'https://line-webhook.karutekun.com/webhook/salons/227';

// LINE Client
let lineClient = null;
function getLineClient() {
  if (!lineClient && LINE_CONFIG.channelAccessToken) {
    lineClient = new line.messagingApi.MessagingApiClient({
      channelAccessToken: LINE_CONFIG.channelAccessToken,
    });
  }
  return lineClient;
}

// Claude Client
const anthropic = new Anthropic({
  apiKey: (process.env.ANTHROPIC_API_KEY || '').trim(),
});

// Slack Client
let slackWeb = null;
function getSlackClient() {
  if (!slackWeb && process.env.SLACK_BOT_TOKEN) {
    slackWeb = new WebClient(process.env.SLACK_BOT_TOKEN);
  }
  return slackWeb;
}

// フリーランスモード or Slack未設定なら通知スキップ
function shouldSkipSlack(session) {
  if (!process.env.SLACK_BOT_TOKEN) return true;
  if (session && session.tenantId) {
    const tenant = getTenant(session.tenantId);
    if (tenant && tenant.mode === 'freelance') return true;
  }
  return false;
}

// ─── テナント別 LINE Client キャッシュ ───
const tenantLineClients = new Map();
const tenantLineBlobClients = new Map();

function getTenantLineClient(tenant) {
  if (!tenant || !tenant.lineChannelAccessToken) return null;
  if (tenantLineClients.has(tenant.id)) return tenantLineClients.get(tenant.id);

  const client = new line.messagingApi.MessagingApiClient({
    channelAccessToken: tenant.lineChannelAccessToken,
  });
  tenantLineClients.set(tenant.id, client);
  return client;
}

function getTenantLineBlobClient(tenant) {
  if (!tenant || !tenant.lineChannelAccessToken) return null;
  if (tenantLineBlobClients.has(tenant.id)) return tenantLineBlobClients.get(tenant.id);

  const blob = new line.messagingApiBlob.MessagingApiBlobClient({
    channelAccessToken: tenant.lineChannelAccessToken,
  });
  tenantLineBlobClients.set(tenant.id, blob);
  return blob;
}

// LINEから画像データを取得してSupabase Storageにアップロード
async function downloadLineImageAndUpload(messageId, tenant, userId) {
  const blob = getTenantLineBlobClient(tenant);
  if (!blob) {
    console.warn('[LINE Image] Blobクライアント未設定');
    return null;
  }

  try {
    const stream = await blob.getMessageContent(messageId);
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    const filename = `${tenant.id}/${userId}/${Date.now()}_${messageId}.jpg`;
    const url = await uploadImageToStorage(buffer, filename, 'image/jpeg');
    console.log(`[LINE Image] アップロード完了: ${url}`);
    return url;
  } catch (err) {
    console.error('[LINE Image] 取得/アップロード失敗:', err.message);
    return null;
  }
}

// ─── Slackスレッド → LINE userId マッピング ───
// key: `${channelId}-${thread_ts}`, value: lineUserId
const threadToLineUser = new Map();

/**
 * Slackスレッドの返信をLINEに転送する（server.jsから呼ばれる）
 */
async function handleSlackReplyToLine(channelId, threadTs, text) {
  const key = `${channelId}-${threadTs}`;
  const lineUserId = threadToLineUser.get(key);
  if (!lineUserId) return false;

  const client = getLineClient();
  if (!client) return false;

  try {
    await client.pushMessage({
      to: lineUserId,
      messages: [{ type: 'text', text }],
    });
    console.log(`[LINE Push] スタッフ返信送信成功: ${lineUserId}`);
    return true;
  } catch (err) {
    console.error(`[LINE Push] スタッフ返信送信失敗:`, err.message);
    return false;
  }
}

// ─── 署名検証 ───
function validateSignature(body, signature, channelSecret) {
  const hash = crypto
    .createHmac('SHA256', channelSecret)
    .update(body)
    .digest('base64');
  return hash === signature;
}

// ============================================
// Webhook エンドポイント
// ============================================
router.post('/', async (req, res) => {
  const signature = req.headers['x-line-signature'];
  if (!signature) {
    console.warn('[LINE Webhook] 署名なし - リクエスト拒否');
    return res.status(401).json({ error: 'Missing signature' });
  }

  const rawBody = req.rawBody;
  if (!rawBody) {
    console.warn('[LINE Webhook] rawBodyなし - リクエスト拒否');
    return res.status(400).json({ error: 'Missing body' });
  }

  if (!validateSignature(rawBody, signature, LINE_CONFIG.channelSecret)) {
    console.warn('[LINE Webhook] 署名不一致 - リクエスト拒否');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // LINEに即座に200を返す
  res.status(200).json({ status: 'ok' });

  // カルテくんへ転送（非同期・失敗しても継続）
  forwardToKarutekun(rawBody, req.headers).catch((err) => {
    console.error('[LINE Webhook] カルテくん転送エラー:', err.message);
  });

  // デフォルトはフリーランスモード
  const tenant = getTenant('freelance');
  if (!tenant) {
    console.error('[LINE Webhook] デフォルトfreelanceテナントが見つかりません');
    return;
  }

  const body = req.body;
  if (!body.events || body.events.length === 0) return;

  console.log(`[LINE Webhook] デフォルト → フリーランスモードで処理 (tenant=${tenant.id})`);

  for (const event of body.events) {
    try {
      await handleFreelanceMode(event, tenant);
    } catch (err) {
      console.error('[LINE Webhook] フリーランスモード処理エラー:', err);
    }
  }
});

// ============================================
// カルテくんへの転送
// ============================================
async function forwardToKarutekun(rawBody, headers) {
  const forwardHeaders = {
    'Content-Type': 'application/json',
    'x-line-signature': headers['x-line-signature'],
  };
  const response = await fetch(KARUTEKUN_WEBHOOK_URL, {
    method: 'POST',
    headers: forwardHeaders,
    body: rawBody,
  });
  console.log(`[LINE Webhook] カルテくん転送結果: ${response.status}`);
}

// ============================================
// イベントハンドラ
// ============================================
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return;
  }

  const userId = event.source.userId;
  const userMessage = event.message.text;
  const replyToken = event.replyToken;

  console.log(`[LINE Webhook] メッセージ受信: userId=${userId}, text="${userMessage}"`);

  // セッション取得/作成
  const session = getOrCreateSession(userId);

  // 表示名を取得（初回のみ）
  if (!session.displayName) {
    try {
      const client = getLineClient();
      if (client) {
        const profile = await client.getProfile(userId);
        session.displayName = profile.displayName;
        setDisplayName(userId, profile.displayName);
        console.log(`[LINE Webhook] 表示名取得: ${profile.displayName}`);
      }
    } catch (err) {
      console.warn('[LINE Webhook] プロフィール取得失敗:', err.message);
    }
  }

  // Supabaseカルテ検索（初回のみ）
  if (!session.customerProfile) {
    try {
      const profile = await getCustomerProfile(userId, 'line_id');
      if (profile) {
        session.customerProfile = profile;
        if (!session.displayName && (profile.customer.customer_name || profile.customer.name)) {
          session.displayName = (profile.customer.customer_name || profile.customer.name);
          setDisplayName(userId, (profile.customer.customer_name || profile.customer.name));
        }
        console.log(`[Supabase] LINE顧客特定: ${(profile.customer.customer_name || profile.customer.name)}`);
      }
    } catch (err) {
      console.warn('[Supabase] LINE顧客検索エラー:', err.message);
    }
  }

  // スタッフ引き継ぎ済みの場合 → Slackスレッドに転送
  if (session.status === 'handoff_to_staff') {
    console.log(`[LINE Webhook] スタッフ対応中 → Slackに転送: ${userId}`);
    await forwardCustomerMessageToSlack(session, userMessage);
    return;
  }

  // 会話履歴にユーザーメッセージ追加
  addMessage(userId, 'user', userMessage);

  // Claude APIでAIカウンセリング
  try {
    const aiResponse = await generateLineCounselingResponse(session);

    // [HANDOFF:スタイリスト名] タグの処理
    const handoffMatch = aiResponse.match(/\[HANDOFF(?::([^\]]*))?\]/);
    const needsHandoff = !!handoffMatch;
    const handoffStaffName = handoffMatch ? (handoffMatch[1] || '未定').trim() : null;
    const cleanResponse = aiResponse.replace(/\[HANDOFF(?::[^\]]*)?]/g, '').trim();

    // 会話履歴にAI応答を追加
    addMessage(userId, 'assistant', cleanResponse);

    // LINE Messaging APIで返信
    await replyToLine(replyToken, cleanResponse);

    // #受付-全件にリアルタイムログ
    await postToAllChannel(session, userMessage, cleanResponse);

    // 引き継ぎ処理
    if (needsHandoff) {
      setStatus(userId, 'handoff_to_staff');
      await sendHandoffToChannels(session, handoffStaffName);
      console.log(`[LINE Webhook] スタッフ引き継ぎ実行: ${userId} → ${handoffStaffName}`);
    }
  } catch (err) {
    console.error('[LINE Webhook] AI応答エラー:', err);
    const errorMessage =
      '申し訳ございません、ただいま接続が不安定です。お手数ですがお電話でお問い合わせください。';
    try {
      await replyToLine(replyToken, errorMessage);
    } catch (replyErr) {
      console.error('[LINE Webhook] エラー返信失敗:', replyErr.message);
    }
  }
}

// ============================================
// Claude API カウンセリング応答生成
// ============================================
async function generateLineCounselingResponse(session) {
  let systemPrompt = buildLineCounselingPrompt();

  // Supabaseカルテ情報をプロンプトに追加
  if (session.customerProfile) {
    systemPrompt += buildKarteContext(session.customerProfile);
  }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: systemPrompt,
    messages: session.conversationHistory,
  });
  return response.content[0].text;
}

// ============================================
// LINE返信
// ============================================
async function replyToLine(replyToken, text) {
  const client = getLineClient();
  if (!client) return;

  try {
    await client.replyMessage({
      replyToken,
      messages: [{ type: 'text', text }],
    });
    console.log(`[LINE Reply] 返信成功`);
  } catch (err) {
    console.error('[LINE Reply] 返信エラー:', err.message);
  }
}

// ============================================
// Slack: #受付-全件にリアルタイムログ
// ============================================
async function postToAllChannel(session, customerMsg, aiMsg) {
  if (shouldSkipSlack(session)) {
    console.log('[Slack] フリーランス/未設定のためスキップ: postToAllChannel');
    return;
  }
  const slack = getSlackClient();
  if (!slack || !CHANNEL_ALL) return;

  const displayName = session.displayName || 'お客様';

  // 初回はスレッド作成、以降はスレッドに追加
  if (!session.slackAllThreadTs) {
    try {
      const result = await slack.chat.postMessage({
        channel: CHANNEL_ALL,
        text: `👤 ${displayName}さま（LINE）\n🤵 コンシェルジュが対応中`,
      });
      session.slackAllThreadTs = result.ts;

      // マッピング登録
      threadToLineUser.set(`${CHANNEL_ALL}-${result.ts}`, session.userId);
    } catch (err) {
      console.error('[Slack #全件] スレッド作成エラー:', err.message);
      return;
    }
  }

  try {
    await slack.chat.postMessage({
      channel: CHANNEL_ALL,
      thread_ts: session.slackAllThreadTs,
      text: `👤 ${displayName}さま（LINE）\n${customerMsg}\n\n🤵 コンシェルジュ\n${aiMsg}`,
    });
  } catch (err) {
    console.error('[Slack #全件] ログ投稿エラー:', err.message);
  }
}

// ============================================
// Slack: 引き継ぎ → 担当チャンネル + #受付-全件
// ============================================
async function sendHandoffToChannels(session, staffName) {
  if (shouldSkipSlack(session)) {
    console.log('[Slack] フリーランス/未設定のためスキップ: sendHandoffToChannels');
    return;
  }
  const slack = getSlackClient();
  if (!slack) return;

  const displayName = session.displayName || 'お客様';
  const history = session.conversationHistory;

  // 会話からメニュー・日時を抽出
  const allText = history.map(m => m.content).join(' ');
  const customerText = history.filter(m => m.role === 'user').map(m => m.content).join(' ');
  let menuItems = [];
  if (allText.includes('カット')) menuItems.push('カット');
  if (allText.includes('カラー')) menuItems.push('カラー');
  if (allText.includes('パーマ')) menuItems.push('パーマ');
  if (allText.includes('縮毛矯正')) menuItems.push('縮毛矯正');
  if (allText.includes('トリートメント')) menuItems.push('トリートメント');
  if (allText.includes('ヘッドスパ')) menuItems.push('ヘッドスパ');
  const menuStr = menuItems.length > 0 ? menuItems.join('・') : '未確認';

  let dateTime = '未確認';
  const dateMatch = customerText.match(/(\d{1,2}月\d{1,2}日|\d{1,2}\/\d{1,2}|明日|明後日|来週|今週)/);
  if (dateMatch) dateTime = dateMatch[0];
  const timeMatch = customerText.match(/(\d{1,2}時|\d{1,2}:\d{2}|午前|午後)/);
  if (timeMatch) dateTime += ' ' + timeMatch[0];

  // 会話ログ
  let conversationLog = '';
  for (const msg of history) {
    if (msg.role === 'user') {
      conversationLog += `👤 ${displayName}さま\n${msg.content}\n\n`;
    } else {
      conversationLog += `🤵 コンシェルジュ\n${msg.content}\n\n`;
    }
  }

  // 髪の状態（2往復目以降のお客様の回答から抽出）
  const customerMessages = history.filter(m => m.role === 'user').map(m => m.content);
  let hairCondition = '';
  if (customerMessages.length >= 2) {
    hairCondition = customerMessages.slice(1).join('、');
  }

  // Supabaseカルテからの補足情報
  let karteNotes = '';
  if (session.customerProfile) {
    const { visits } = session.customerProfile;
    if (visits && visits.length > 0) {
      const lastVisit = visits[0];
      const daysSince = Math.floor(
        (Date.now() - new Date(lastVisit.visited_at)) / (1000 * 60 * 60 * 24)
      );
      karteNotes = `前回来店: ${daysSince}日前（${lastVisit.menu}）`;
    }
  }

  // ─── 担当チャンネルに投稿 ───
  const stylistChannelId = getChannelForStylist(staffName);
  if (stylistChannelId) {
    try {
      const result = await slack.chat.postMessage({
        channel: stylistChannelId,
        text: [
          '📋引き継ぎ議事録',
          '━━━━━━━━━━',
          `👤 ${displayName}さま`,
          `💇 指名：${staffName && staffName !== '未定' ? staffName : '指名なし'}`,
          `📅 希望：${dateTime}`,
          `✂️ メニュー：${menuStr}`,
          hairCondition ? `💬 髪の状態：${hairCondition}` : '',
          karteNotes ? `📝 その他：${karteNotes}` : '',
          '━━━━━━━━━━',
          `担当スタッフはこのスレッドで直接返信してください。`,
        ].filter(Boolean).join('\n'),
      });

      // スレッド内に会話ログを投稿
      await slack.chat.postMessage({
        channel: stylistChannelId,
        thread_ts: result.ts,
        text: `💬 カウンセリングログ\n━━━━━━━━━━\n${conversationLog}━━━━━━━━━━`,
      });

      // マッピング登録（スタッフの返信 → LINE転送用）
      threadToLineUser.set(`${stylistChannelId}-${result.ts}`, session.userId);
      session.slackStylistThreadTs = result.ts;
      session.slackStylistChannelId = stylistChannelId;

      console.log(`[Slack] 担当チャンネル投稿成功: ${staffName}`);
    } catch (err) {
      console.error(`[Slack] 担当チャンネル投稿エラー:`, err.message);
    }
  }

  // ─── #受付-全件にも引き継ぎ通知 ───
  if (CHANNEL_ALL && session.slackAllThreadTs) {
    try {
      await slack.chat.postMessage({
        channel: CHANNEL_ALL,
        thread_ts: session.slackAllThreadTs,
        text: [
          '📋引き継ぎ議事録',
          '━━━━━━━━━━',
          `👤 ${displayName}さま`,
          `💇 指名：${staffName || '未定'}`,
          `📅 希望：${dateTime}`,
          `✂️ メニュー：${menuStr}`,
          hairCondition ? `💬 髪の状態：${hairCondition}` : '',
          karteNotes ? `📝 その他：${karteNotes}` : '',
          '━━━━━━━━━━',
        ].filter(Boolean).join('\n'),
      });

      // スレッドのメインメッセージを更新
      await slack.chat.update({
        channel: CHANNEL_ALL,
        ts: session.slackAllThreadTs,
        text: `👤 ${displayName}さま（LINE） → 💇 ${staffName || '担当未定'} に引き継ぎ済み`,
      });
    } catch (err) {
      console.error('[Slack #全件] 引き継ぎ通知エラー:', err.message);
    }
  }
}

// ============================================
// 引き継ぎ後：お客様のメッセージをSlackスレッドに転送
// ============================================
async function forwardCustomerMessageToSlack(session, message) {
  if (shouldSkipSlack(session)) {
    console.log('[Slack] フリーランス/未設定のためスキップ: forwardCustomerMessageToSlack');
    return;
  }
  const slack = getSlackClient();
  if (!slack) return;

  const displayName = session.displayName || 'お客様';

  // 担当チャンネルのスレッドに投稿
  if (session.slackStylistChannelId && session.slackStylistThreadTs) {
    try {
      await slack.chat.postMessage({
        channel: session.slackStylistChannelId,
        thread_ts: session.slackStylistThreadTs,
        text: `👤 ${displayName}さま（LINE）\n${message}`,
      });
    } catch (err) {
      console.error('[Slack] お客様メッセージ転送エラー:', err.message);
    }
  }

  // #受付-全件のスレッドにも投稿
  if (CHANNEL_ALL && session.slackAllThreadTs) {
    try {
      await slack.chat.postMessage({
        channel: CHANNEL_ALL,
        thread_ts: session.slackAllThreadTs,
        text: `👤 ${displayName}さま（LINE）\n${message}`,
      });
    } catch (err) {
      console.error('[Slack #全件] お客様メッセージ転送エラー:', err.message);
    }
  }
}

// ============================================
// テナント別 Webhook エンドポイント
// /webhook/line/:tenantId
// ============================================
router.post('/:tenantId', async (req, res) => {
  const tenant = getTenant(req.params.tenantId);
  if (!tenant) {
    console.warn(`[LINE Webhook] テナント不明: ${req.params.tenantId}`);
    return res.status(404).json({ error: 'Tenant not found' });
  }

  const signature = req.headers['x-line-signature'];
  if (!signature) {
    return res.status(401).json({ error: 'Missing signature' });
  }

  const rawBody = req.rawBody;
  if (!rawBody) {
    return res.status(400).json({ error: 'Missing body' });
  }

  // テナントごとのChannel Secretで署名検証
  if (!validateSignature(rawBody, signature, tenant.lineChannelSecret)) {
    console.warn(`[LINE Webhook] 署名不一致 (tenant: ${tenant.id})`);
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // LINEに即座に200を返す
  res.status(200).json({ status: 'ok' });

  // モードに応じた処理を分岐
  const body = req.body;
  if (!body.events || body.events.length === 0) return;

  if (tenant.mode === 'salon') {
    // サロンモード: カルテくん転送 + 既存処理
    if (tenant.karutekunWebhook) {
      forwardToKarutekunWithUrl(rawBody, req.headers, tenant.karutekunWebhook).catch((err) => {
        console.error('[LINE Webhook] カルテくん転送エラー:', err.message);
      });
    }
    for (const event of body.events) {
      try {
        await handleEvent(event);
      } catch (err) {
        console.error('[LINE Webhook] サロンモード処理エラー:', err);
      }
    }
  } else if (tenant.mode === 'freelance') {
    // フリーランスモード
    for (const event of body.events) {
      try {
        await handleFreelanceMode(event, tenant);
      } catch (err) {
        console.error('[LINE Webhook] フリーランスモード処理エラー:', err);
      }
    }
  }
});

// ============================================
// カルテくん転送（URL指定版）
// ============================================
async function forwardToKarutekunWithUrl(rawBody, headers, webhookUrl) {
  const forwardHeaders = {
    'Content-Type': 'application/json',
    'x-line-signature': headers['x-line-signature'],
  };
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: forwardHeaders,
    body: rawBody,
  });
  console.log(`[LINE Webhook] カルテくん転送結果: ${response.status}`);
}

// ============================================
// フリーランスモード処理
// ============================================
async function handleFreelanceMode(event, tenant) {
  if (event.type !== 'message') return;
  if (event.message.type !== 'text' && event.message.type !== 'image') {
    return;
  }

  const userId = event.source.userId;
  const replyToken = event.replyToken;
  const isImage = event.message.type === 'image';

  // 画像の場合はLINEから取得してStorageにアップロード
  let imageUrl = null;
  if (isImage) {
    imageUrl = await downloadLineImageAndUpload(event.message.id, tenant, userId);
  }

  // AIに渡すメッセージテキスト
  const userMessage = isImage
    ? 'お客様が参考画像を送りました'
    : event.message.text;

  console.log(`[Freelance] メッセージ受信: tenant=${tenant.id}, userId=${userId}`);

  // セッション取得/作成
  const session = getOrCreateSession(userId);

  // テナント情報をセッションに紐付け
  session.tenantId = tenant.id;

  // 表示名を取得（初回のみ）
  if (!session.displayName) {
    try {
      const client = getTenantLineClient(tenant);
      if (client) {
        const profile = await client.getProfile(userId);
        session.displayName = profile.displayName;
        setDisplayName(userId, profile.displayName);
        console.log(`[Freelance] 表示名取得: ${profile.displayName}`);
      }
    } catch (err) {
      console.warn('[Freelance] プロフィール取得失敗:', err.message);
    }
  }

  // Supabaseカルテ検索（初回のみ）
  if (!session.customerProfile) {
    try {
      const profile = await getCustomerProfile(userId, 'line_id');
      if (profile) {
        session.customerProfile = profile;
        if (!session.displayName && (profile.customer.customer_name || profile.customer.name)) {
          session.displayName = (profile.customer.customer_name || profile.customer.name);
          setDisplayName(userId, (profile.customer.customer_name || profile.customer.name));
        }
        console.log(`[Freelance] 顧客特定: ${(profile.customer.customer_name || profile.customer.name)}`);
      }
    } catch (err) {
      console.warn('[Freelance] 顧客検索エラー:', err.message);
    }
  }

  // スタッフ引き継ぎ済みの場合 → 追加メッセージもログに保存
  if (session.status === 'handoff_to_staff') {
    console.log(`[Freelance] 引き継ぎ済み → ログ保存のみ: ${userId}`);
    await saveConversationLog({
      tenantId: tenant.id,
      customerId: session.customerProfile?.customer?.id || null,
      lineUserId: userId,
      customerMessage: userMessage,
      aiResponse: '（引き継ぎ済み・オーナー対応中）',
      messageType: isImage ? 'image' : 'text',
      imageUrl: imageUrl,
      timestamp: new Date(),
    });
    return;
  }

  // 会話履歴にユーザーメッセージ追加
  addMessage(userId, 'user', userMessage);

  // AIカウンセリング応答生成
  try {
    const aiResponse = await generateFreelanceResponse(session, tenant);

    // [HANDOFF] タグの処理
    const needsHandoff = aiResponse.includes('[HANDOFF]');
    const cleanResponse = aiResponse.replace(/\[HANDOFF\]/g, '').trim();

    // 会話履歴にAI応答を追加
    addMessage(userId, 'assistant', cleanResponse);

    // LINE返信（テナント別クライアント使用）
    await replyToLineWithClient(replyToken, cleanResponse, tenant);

    // Supabaseに会話ログ保存
    await saveConversationLog({
      tenantId: tenant.id,
      customerId: session.customerProfile?.customer?.id || null,
      lineUserId: userId,
      customerMessage: userMessage,
      aiResponse: cleanResponse,
      isHandoff: needsHandoff,
      messageType: isImage ? 'image' : 'text',
      imageUrl: imageUrl,
      timestamp: new Date(),
    });

    // 引き継ぎが必要な場合、本人に通知
    if (needsHandoff) {
      setStatus(userId, 'handoff_to_staff');

      const handoffData = buildFreelanceHandoffData(session);

      // handoff_summaryもログに保存
      await saveConversationLog({
        tenantId: tenant.id,
        customerId: session.customerProfile?.customer?.id || null,
        lineUserId: userId,
        customerMessage: '（引き継ぎ議事録）',
        aiResponse: handoffData.message,
        isHandoff: true,
        handoffSummary: handoffData.summary,
        timestamp: new Date(),
      });

      await notifyOwner(tenant, handoffData);
      console.log(`[Freelance] オーナー通知完了: tenant=${tenant.id}, userId=${userId}`);
    }
  } catch (err) {
    console.error('[Freelance] AI応答エラー:', err);
    const errorMessage =
      '申し訳ございません、ただいま接続が不安定です。お手数ですがしばらくしてからお試しください。';
    try {
      await replyToLineWithClient(replyToken, errorMessage, tenant);
    } catch (replyErr) {
      console.error('[Freelance] エラー返信失敗:', replyErr.message);
    }
  }
}

// ============================================
// フリーランスモード AI応答生成
// ============================================
async function generateFreelanceResponse(session, tenant) {
  // カルテコンテキスト構築
  let karteContext = '';
  if (session.customerProfile) {
    karteContext = buildKarteContext(session.customerProfile);
  }

  let systemPrompt = buildFreelanceCounselingPrompt(tenant, karteContext);

  // 2往復未満は引き継ぎ禁止
  const userTurnCount = session.conversationHistory.filter(m => m.role === 'user').length;
  const isImmediateHandoff = needsImmediateHandoffCheck(
    session.conversationHistory.length > 0
      ? session.conversationHistory[session.conversationHistory.length - 1].content
      : ''
  );

  if (userTurnCount < 2 && !isImmediateHandoff) {
    systemPrompt += '\n\n【重要】まだお客様との会話が1往復目です。絶対に[HANDOFF]を出さないでください。髪の状態や悩みを1つ質問してください。';
  }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: systemPrompt,
    messages: session.conversationHistory,
  });
  return response.content[0].text;
}

// 即時引き継ぎキーワード判定
function needsImmediateHandoffCheck(text) {
  const urgentPatterns = [
    'スタッフと話', '人と話', '人に代わ', '繋いで', 'つないで',
    'クレーム', '苦情', '怒', '最悪', '許せない', '緊急', '至急',
    '直接相談',
  ];
  return urgentPatterns.some(p => text.includes(p));
}

// ============================================
// フリーランス引き継ぎデータ構築
// ============================================
function buildFreelanceHandoffData(session) {
  const history = session.conversationHistory;
  const displayName = session.displayName || 'お客様';
  const customerMessages = history.filter(m => m.role === 'user').map(m => m.content);
  const allText = history.map(m => m.content).join(' ');

  // メニュー抽出
  let menuItems = [];
  if (allText.includes('カット')) menuItems.push('カット');
  if (allText.includes('カラー')) menuItems.push('カラー');
  if (allText.includes('パーマ')) menuItems.push('パーマ');
  if (allText.includes('縮毛矯正')) menuItems.push('縮毛矯正');
  if (allText.includes('トリートメント')) menuItems.push('トリートメント');
  if (allText.includes('ヘッドスパ')) menuItems.push('ヘッドスパ');
  const menuStr = menuItems.length > 0 ? menuItems.join('・') : '未定';

  // 希望日時抽出
  const customerText = customerMessages.join(' ');
  let dateTime = '未定';
  const dateMatch = customerText.match(/(明日|明後日|来週|今週|今日|\d{1,2}月\d{1,2}日|\d{1,2}\/\d{1,2})/);
  if (dateMatch) dateTime = dateMatch[0];
  const timeMatch = customerText.match(/(\d{1,2}時(半)?|\d{1,2}:\d{2}|午前|午後)/);
  if (timeMatch) dateTime += ' ' + timeMatch[0];

  // 髪の状態
  let hairCondition = '';
  if (customerMessages.length >= 2) {
    hairCondition = customerMessages.slice(1).join('、');
  }

  // 会話ログ
  let conversationLog = '';
  for (const msg of history) {
    if (msg.role === 'user') {
      conversationLog += `👤 ${displayName}さま\n${msg.content}\n\n`;
    } else {
      conversationLog += `🤵 コンシェルジュ\n${msg.content}\n\n`;
    }
  }

  const summary = {
    customer: displayName,
    menu: menuStr,
    dateTime: dateTime,
    hairCondition: hairCondition || '未確認',
    notes: '',
  };

  const message = `📋 新しいお問い合わせ（AI引き継ぎ）
━━━━━━━━━━
👤 ${displayName}
✂️ メニュー: ${summary.menu}
📅 希望: ${summary.dateTime}
💬 髪の状態: ${summary.hairCondition}
📝 その他: ${summary.notes || 'なし'}
━━━━━━━━━━

💬 会話ログ:
${conversationLog}`;

  return { summary, message, conversationLog };
}

// ============================================
// オーナー通知（フリーランスモード）
// ============================================
async function notifyOwner(tenant, handoffData) {
  const notification = tenant.notification;
  if (!notification || !notification.destination) {
    console.warn(`[Freelance] 通知先未設定: tenant=${tenant.id}`);
    return;
  }

  switch (notification.type) {
    case 'email':
      await sendEmailNotification(notification.destination, handoffData.message);
      break;
    case 'line':
      // オーナーの別のLINEアカウントにプッシュ通知
      await pushToLineOwner(notification.destination, handoffData.message, tenant);
      break;
    case 'push':
      // マイコン管理画面のプッシュ通知（将来実装）
      console.log(`[Freelance] プッシュ通知は未実装: tenant=${tenant.id}`);
      break;
    default:
      console.warn(`[Freelance] 不明な通知タイプ: ${notification.type}`);
  }
}

// メール通知（将来的にSendGrid等に置き換え）
async function sendEmailNotification(to, body) {
  // TODO: SendGrid / SES 等のメール送信実装
  console.log(`[Freelance Email] 通知送信先: ${to}`);
  console.log(`[Freelance Email] 内容:\n${body}`);
}

// LINEプッシュ通知（オーナー宛）
async function pushToLineOwner(ownerLineUserId, message, tenant) {
  const client = getTenantLineClient(tenant);
  if (!client) {
    console.warn('[Freelance LINE Push] クライアント未設定');
    return;
  }

  try {
    await client.pushMessage({
      to: ownerLineUserId,
      messages: [{ type: 'text', text: message }],
    });
    console.log(`[Freelance LINE Push] オーナー通知成功: ${ownerLineUserId}`);
  } catch (err) {
    console.error(`[Freelance LINE Push] オーナー通知失敗:`, err.message);
  }
}

// ============================================
// LINE返信（テナント別クライアント使用）
// ============================================
async function replyToLineWithClient(replyToken, text, tenant) {
  const client = getTenantLineClient(tenant);
  if (!client) {
    console.warn('[Freelance LINE Reply] クライアント未設定');
    return;
  }

  try {
    await client.replyMessage({
      replyToken,
      messages: [{ type: 'text', text }],
    });
    console.log(`[Freelance LINE Reply] 返信成功`);
  } catch (err) {
    console.error('[Freelance LINE Reply] 返信エラー:', err.message);
  }
}

module.exports = router;
module.exports.handleSlackReplyToLine = handleSlackReplyToLine;
module.exports.threadToLineUser = threadToLineUser;
