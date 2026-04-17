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
  patchSession,
  setConversationState,
  resumeAiMode,
  markStaffActive,
  isStaffActive,
} = require('../services/lineCounselingSession');
const { classifyHandoffMessage, scheduleSla, clearSlaTimers } = require('../services/handoffMode');

// 引き継ぎ後、15分でAI対応に自動復帰する閾値
const HANDOFF_AUTO_RELEASE_MS = 15 * 60 * 1000;

/**
 * handoff 状態のセッションが 15分経過していたら bot_active に戻す。
 * 戻した場合は true を返す（呼び出し側は通常AIフローへ進む）。
 */
function maybeAutoReleaseHandoff(session) {
  if (!session || session.status !== 'handoff_to_staff') return false;
  const startedAt = session.handoffStartedAt || 0;
  if (!startedAt) return false;
  const handoffDurationMs = Date.now() - startedAt;
  if (handoffDurationMs < HANDOFF_AUTO_RELEASE_MS) return false;

  const userId = session.userId;
  console.log(`[Handoff Auto Reset] ${userId} 15分経過でbot_active復帰 (duration=${handoffDurationMs}ms)`);
  clearSlaTimers(userId);
  setStatus(userId, 'counseling');
  patchSession(userId, {
    conversationState: 'bot_active',
    assignedStaffId: null,
    handoffStartedAt: null,
    staffLastResponseAt: null,
    holdingMessageSent: false,
  });

  // 監査ログ
  logCustomerAccess({
    action: 'handoff_auto_reset',
    actor: 'system',
    customerId: session.customerProfile?.customer?.id || null,
    details: {
      lineUserId: userId,
      handoffDurationMs,
      handoffStartedAt: new Date(startedAt).toISOString(),
      staffResponded: !!session.staffLastResponseAt,
    },
  }).catch(() => {});

  return true;
}
const { runLinkingFlow } = require('../services/customerLinking');
const { buildLineCounselingPrompt } = require('../prompts/lineCounseling');
const { buildFreelanceCounselingPrompt } = require('../prompts/freelanceCounseling');
const { findStaffByName } = require('../config/staff');
const { getTenant } = require('../config/tenants');
const { getCustomerProfile, saveConversationLog, uploadImageToStorage, hasPriorConversation, logCustomerAccess } = require('../supabase-client');
const { buildKarteContext } = require('../ai-receptionist');
const { CHANNEL_ALL, CHANNEL_NEW, getChannelForStylist } = require('../config/slackChannels');

const router = express.Router();

// ─── 設定 ───
const LINE_CONFIG = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET || '',
};

// LINE Webhookのプロキシ転送先（カルテくん）
// 優先順位: WEBHOOK_FORWARD_URL > KARUTEKUN_WEBHOOK_URL > 既定値
const WEBHOOK_FORWARD_URL =
  process.env.WEBHOOK_FORWARD_URL ||
  process.env.KARUTEKUN_WEBHOOK_URL ||
  'https://line-webhook.karutekun.com/webhook/salons/227';

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

// ─── 「考えてる感」を出す返信遅延ロジック ───
function getJstHourForDelay() {
  const h = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    hour12: false,
  }).format(new Date());
  const n = parseInt(h, 10);
  return Number.isFinite(n) ? n % 24 : 0;
}

/**
 * AIの返信文の長さと時刻から自然な遅延ms値を返す
 *   - 短文(<=30): 3000-5000
 *   - 通常(31-80): 5000-8000
 *   - 長文(>=81): 6000-12000
 *   - 20%の確率で1000-2000ms即レス
 *   - 深夜(23-5:59) なら +5000ms（最大15000まで）
 */
function computeReplyDelayMs(text, hourJST) {
  const len = (text || '').length;
  let baseMin, baseMax;
  if (len <= 30) { baseMin = 3000; baseMax = 5000; }
  else if (len <= 80) { baseMin = 5000; baseMax = 8000; }
  else { baseMin = 6000; baseMax = 12000; }

  // 20% で即レス
  if (Math.random() < 0.2) {
    return 1000 + Math.floor(Math.random() * 1000);
  }

  let delay = baseMin + Math.floor(Math.random() * (baseMax - baseMin));

  // 深夜は +5s（上限15s）
  const isLateNight = hourJST >= 23 || hourJST < 6;
  if (isLateNight) {
    delay = Math.min(delay + 5000, 15000);
  }

  return delay;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// LINEのチャット読み込み中インジケーター（最大60秒、5秒刻み）
async function showTypingIndicator(tenant, userId, delayMs) {
  if (!tenant || !tenant.lineChannelAccessToken || !userId) return;
  // 5秒単位に切り上げ、最低5秒、最大60秒
  const seconds = Math.min(60, Math.max(5, Math.ceil(delayMs / 5000) * 5));
  try {
    const res = await fetch('https://api.line.me/v2/bot/chat/loading/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tenant.lineChannelAccessToken}`,
      },
      body: JSON.stringify({ chatId: userId, loadingSeconds: seconds }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[LINE Typing] インジケーター失敗 ${res.status}: ${body.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn('[LINE Typing] インジケーターエラー:', err.message);
  }
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

    // 状態遷移: conversationState のみ staff_active に（AI排他制御発動）。
    // session.status は既に handoff_to_staff のはずなので触らない（旧挙動に戻す）。
    patchSession(lineUserId, {
      conversationState: 'staff_active',
      staffLastResponseAt: Date.now(),
    });
    clearSlaTimers(lineUserId);
    console.log(`[Handoff State] ${lineUserId} → staff_active (staff replied via Slack)`);

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

  // KaruteKunへプロキシ転送（非同期・失敗しても処理継続）
  forwardWebhook(rawBody, req.headers);

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
// LINE Webhook プロキシ転送
// 受信したリクエストのrawBodyとx-line-signatureを指定URLへ非同期転送
// 失敗してもログのみ出力し、呼び出し元の処理は継続する
// ============================================
function forwardWebhook(rawBody, headers, url) {
  const targetUrl = url || WEBHOOK_FORWARD_URL;
  if (!targetUrl) return;

  const forwardHeaders = {
    'Content-Type': 'application/json',
    'x-line-signature': headers['x-line-signature'] || '',
  };

  // 非同期 fire-and-forget。タイムアウトで自分の処理をブロックしない。
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  fetch(targetUrl, {
    method: 'POST',
    headers: forwardHeaders,
    body: rawBody,
    signal: controller.signal,
  })
    .then((response) => {
      clearTimeout(timeoutId);
      console.log(`[LINE Forward] 転送完了 → ${targetUrl} status=${response.status}`);
    })
    .catch((err) => {
      clearTimeout(timeoutId);
      console.error(`[LINE Forward] 転送エラー → ${targetUrl}: ${err.message}`);
    });
}

// 後方互換エイリアス（既存呼び出し箇所を壊さない）
function forwardToKarutekun(rawBody, headers) {
  forwardWebhook(rawBody, headers);
  return Promise.resolve();
}

// ============================================
// Postback ハンドラ（AI呼び起こしボタン）
// ============================================
/**
 * 引き継ぎメッセージに添付した Postback ボタンを処理する。
 * data=action=resume_ai ならセッションを ai_resumed に戻し、AI再応答のきっかけメッセージを返す。
 * @param {object} event LINE event (type=postback)
 * @param {object|null} tenant テナント（null ならデフォルトLINEクライアントを使用）
 * @returns {boolean} 処理した場合 true
 */
async function handleResumeAiPostback(event, tenant) {
  if (!event || event.type !== 'postback') return false;
  const data = event.postback?.data || '';
  const params = new URLSearchParams(data);
  if (params.get('action') !== 'resume_ai') return false;

  const userId = event.source?.userId;
  const replyToken = event.replyToken;
  if (!userId) return true;

  // スタッフが既に返信を始めている場合は AI に戻さない
  const currentSession = getOrCreateSession(userId);
  if (isStaffActive(currentSession)) {
    console.log(`[Handoff] ${userId} Postback(resume_ai) ignored: already staff_active`);
    // 抑止した postback も監査ログに残す（可視化漏れ防止）
    if (tenant) {
      await saveConversationLog({
        tenantId: tenant.id,
        customerId: currentSession.customerProfile?.customer?.id || null,
        lineUserId: userId,
        customerMessage: '（AIに相談するボタン押下・抑止）',
        aiResponse: '担当が対応中のため抑止',
        messageType: 'text',
        timestamp: new Date(),
      });
    }
    try {
      const waitText = '担当が対応中です。そのままお待ちください🙏';
      if (tenant) {
        await replyToLineWithClient(replyToken, waitText, tenant);
      } else {
        await replyToLine(replyToken, waitText);
      }
    } catch (err) {
      console.warn('[Handoff Postback] 抑止メッセージ送信失敗:', err.message);
    }
    return true;
  }

  const session = resumeAiMode(userId);
  clearSlaTimers(userId);
  console.log(`[Handoff] ${userId} Postback(resume_ai) → ai_resumed`);

  logCustomerAccess({
    action: 'handoff_manual_reset',
    actor: 'customer',
    customerId: session?.customerProfile?.customer?.id || null,
    details: { lineUserId: userId, trigger: 'postback_resume_ai' },
  }).catch(() => {});

  const resumeText = 'お待たせしてすみません😊\nどんなことでしょう？';
  try {
    if (tenant) {
      await replyToLineWithClient(replyToken, resumeText, tenant);
    } else {
      await replyToLine(replyToken, resumeText);
    }
  } catch (err) {
    console.warn('[Handoff Postback] 復帰メッセージ送信失敗:', err.message);
  }
  return true;
}

// ============================================
// イベントハンドラ
// ============================================
async function handleEvent(event) {
  // Postback: AI呼び起こしボタン
  if (event.type === 'postback') {
    await handleResumeAiPostback(event, null);
    return;
  }
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
        if (!session.displayName && (profile.customer.customer_name)) {
          session.displayName = (profile.customer.customer_name);
          setDisplayName(userId, (profile.customer.customer_name));
        }
        console.log(`[Supabase] LINE顧客特定: ${(profile.customer.customer_name)}`);
        logCustomerAccess({
          action: 'customer_view',
          actor: 'ai',
          customerId: profile.customer.id,
          details: { context: 'chat_lookup', lineUserId: userId, mode: 'salon' },
        }).catch(() => {});
      }
    } catch (err) {
      console.warn('[Supabase] LINE顧客検索エラー:', err.message);
    }
  }

  // スタッフ引き継ぎ済みの場合 → 15分超なら自動解除、それ以外はSlackスレッドに転送
  if (session.status === 'handoff_to_staff') {
    if (!maybeAutoReleaseHandoff(session)) {
      console.log(`[LINE Webhook] スタッフ対応中 → Slackに転送: ${userId}`);
      await forwardCustomerMessageToSlack(session, userMessage);
      return;
    }
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
    // サロンモード: KaruteKun転送 + 既存処理
    // テナント設定 > 環境変数 の順で転送先URLを決定
    forwardWebhook(rawBody, req.headers, tenant.karutekunWebhook || WEBHOOK_FORWARD_URL);
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
// 引き継ぎ済みモード（handoff mode）
// ============================================

// SlackスタイリストスレッドにテキストをポストするヘルパDM (失敗は握りつぶす)
async function postToHandoffSlackThread(session, tenant, text) {
  if (shouldSkipSlack(session)) return;
  const slack = getSlackClient();
  if (!slack) return;
  if (!session.slackStylistChannelId || !session.slackStylistThreadTs) return;
  try {
    await slack.chat.postMessage({
      channel: session.slackStylistChannelId,
      thread_ts: session.slackStylistThreadTs,
      text,
    });
  } catch (err) {
    console.warn('[Handoff Slack] 通知失敗:', err.message);
  }
}

/**
 * 引き継ぎ済みセッションでお客様メッセージを受信したときの処理
 * 分類 → ログ保存 → レベル別の動作
 */
async function handleHandoffModeMessage(session, tenant, userId, userMessage, replyToken, isImage, imageUrl) {
  const customerName = session.displayName || 'お客様';

  // ─── クイックリプライ検知: AIに戻る / 担当を待つ ───
  if (AI_RETURN_RE.test(userMessage)) {
    // スタッフが既に返信を始めていたらAI復帰はブロック（排他制御）
    // 抑止したケースでもお客様の発話はログに残す（表示漏れ防止）
    if (isStaffActive(session)) {
      console.log(`[Handoff] ${userId} AI復帰要求を抑止: staff_active`);
      await saveConversationLog({
        tenantId: tenant.id,
        customerId: session.customerProfile?.customer?.id || null,
        lineUserId: userId,
        customerMessage: userMessage,
        aiResponse: '（スタッフ対応中・AI復帰抑止）',
        messageType: 'text',
        timestamp: new Date(),
      });
      await replyToLineWithClient(replyToken, '担当が対応中です。そのままお待ちください🙏', tenant);
      return;
    }
    console.log(`[Handoff] ${userId} AIに相談したい → bot_active に復帰`);
    clearSlaTimers(userId);
    setStatus(userId, 'counseling');
    const handoffDurationMs = session.handoffStartedAt ? Date.now() - session.handoffStartedAt : 0;
    patchSession(userId, {
      conversationState: 'bot_active',
      assignedStaffId: null,
      handoffStartedAt: null,
      staffLastResponseAt: null,
      holdingMessageSent: false,
    });
    logCustomerAccess({
      action: 'handoff_manual_reset',
      actor: 'customer',
      customerId: session.customerProfile?.customer?.id || null,
      details: { lineUserId: userId, handoffDurationMs, trigger: 'quick_reply' },
    }).catch(() => {});
    await saveConversationLog({
      tenantId: tenant.id,
      customerId: session.customerProfile?.customer?.id || null,
      lineUserId: userId,
      customerMessage: userMessage,
      aiResponse: 'かしこまりました😊 どんなことでしょうか？',
      timestamp: new Date(),
    });
    await replyToLineWithClient(replyToken, 'かしこまりました😊 どんなことでしょうか？', tenant);
    return;
  }

  if (WAIT_STAFF_RE.test(userMessage)) {
    console.log(`[Handoff] ${userId} 担当を待つ → handoff継続`);
    await saveConversationLog({
      tenantId: tenant.id,
      customerId: session.customerProfile?.customer?.id || null,
      lineUserId: userId,
      customerMessage: userMessage,
      aiResponse: '（担当を待つ選択）',
      timestamp: new Date(),
    });
    await postToHandoffSlackThread(session, tenant, `📩 ${customerName}さんが「担当を待つ」を選択しました`);
    return;
  }

  // クラシファイ
  const level = await classifyHandoffMessage(userMessage);
  console.log(`[Handoff] ${userId} メッセージ分類: ${level} state=${session.conversationState}`);

  // 必ず会話ログに保存
  await saveConversationLog({
    tenantId: tenant.id,
    customerId: session.customerProfile?.customer?.id || null,
    lineUserId: userId,
    customerMessage: userMessage,
    aiResponse: `（引き継ぎ済み・${level}）`,
    messageType: isImage ? 'image' : 'text',
    imageUrl: imageUrl,
    timestamp: new Date(),
  });

  // 監査ログ
  logCustomerAccess({
    action: 'handoff_message_received',
    actor: 'ai',
    customerId: session.customerProfile?.customer?.id || null,
    details: { lineUserId: userId, level, conversationState: session.conversationState },
  }).catch(() => {});

  if (level === 'emergency') {
    // クレーム: AI絶対しゃべらない、Slackに⚠️タグで緊急通知
    await postToHandoffSlackThread(
      session,
      tenant,
      `⚠️ *クレーム/苦情の可能性*\n👤 ${customerName}\n>${userMessage}\n（AIは応答しません。至急ご対応ください）`
    );
    return;
  }

  if (level === 'level0') {
    // 無反応: ログのみ。Slack通知も不要
    return;
  }

  if (level === 'level1') {
    // サイレント通知: Slackに転送だけ
    await postToHandoffSlackThread(
      session,
      tenant,
      `📩 ${customerName}（引き継ぎ後）\n>${userMessage}`
    );
    // クールダウン中だった場合、メッセージが来たので human_active に戻す（スタッフが返すまで保留）
    return;
  }

  if (level === 'level2') {
    // Slack通知は必ず行う
    await postToHandoffSlackThread(
      session,
      tenant,
      `📨 *本題の問い合わせ*\n👤 ${customerName}\n>${userMessage}`
    );

    // 条件付き一次受け：スタッフ未応答 かつ handoff から10分超 かつ 一次受け未送信
    const handoffStartedAt = session.handoffStartedAt || 0;
    const elapsed = Date.now() - handoffStartedAt;
    const noStaffYet = !session.staffLastResponseAt;
    const cooledOff = elapsed > 10 * 60 * 1000;

    if (noStaffYet && cooledOff && !session.holdingMessageSent) {
      const holdingText = 'ご連絡ありがとうございます。担当が確認し次第ご連絡します。';
      try {
        await replyToLineWithClient(replyToken, holdingText, tenant, { quickReply: HANDOFF_QUICK_REPLY });
        patchSession(userId, { holdingMessageSent: true });
        console.log(`[Handoff] ${userId} 一次受け送信（10分SLA超え・QR付き）`);
      } catch (err) {
        console.warn('[Handoff] 一次受け送信失敗:', err.message);
      }
    }
    return;
  }
}

/**
 * SLAタイマーをスケジュール
 *  5分: スタッフ未返信なら Slack 再通知
 * 10分: スタッフ未返信ならお客様に「担当が確認中ですので、少々お待ちください」（1回だけ）
 * 20分: 全体チャンネル/CHANNEL_ALLにエスカレーション
 */
function scheduleHandoffSla(session, tenant) {
  const userId = session.userId;
  const customerName = session.displayName || 'お客様';

  scheduleSla(userId, {
    onFiveMin: async () => {
      const s = getOrCreateSession(userId);
      if (s.staffLastResponseAt) return;
      console.log(`[Handoff SLA 5min] ${userId} スタッフ未応答 → Slack再通知`);
      await postToHandoffSlackThread(
        s,
        tenant,
        `⏰ 5分経過：${customerName}さんへの返信がまだです。ご対応ください。`
      );
    },
    onTenMin: async () => {
      const s = getOrCreateSession(userId);
      if (s.staffLastResponseAt) return;
      if (s.holdingMessageSent) return;
      console.log(`[Handoff SLA 10min] ${userId} → お客様へ業務的な一次受け（QR付き）`);
      try {
        await pushWithQuickReply(
          userId,
          '担当が確認中ですので、少々お待ちください。',
          tenant,
          HANDOFF_QUICK_REPLY
        );
        patchSession(userId, { holdingMessageSent: true });
      } catch (err) {
        console.warn('[Handoff SLA 10min] LINE送信失敗:', err.message);
      }
      await postToHandoffSlackThread(
        s,
        tenant,
        `⏰ 10分経過：${customerName}さんに「担当が確認中」と一次受けを送りました。`
      );
    },
    onTwentyMin: async () => {
      const s = getOrCreateSession(userId);
      if (s.staffLastResponseAt) return;
      console.log(`[Handoff SLA 20min] ${userId} → エスカレーション`);
      // 担当チャンネル
      await postToHandoffSlackThread(
        s,
        tenant,
        `🚨 *20分応答なし*\n${customerName}さんが${customerName}担当を待っています。別担当のフォローをお願いします。`
      );
      // 全体チャンネル（あれば）
      if (CHANNEL_ALL && !shouldSkipSlack(s)) {
        const slack = getSlackClient();
        if (slack) {
          try {
            await slack.chat.postMessage({
              channel: CHANNEL_ALL,
              text: `🚨 *エスカレーション*\n${customerName}さん（LINE）への返信が20分滞留中。フォロー願います。`,
            });
          } catch (err) {
            console.warn('[Handoff SLA 20min] CHANNEL_ALL通知失敗:', err.message);
          }
        }
      }
    },
  });
}

// ============================================
// フリーランスモード処理
// ============================================
async function handleFreelanceMode(event, tenant) {
  // Postback: AI呼び起こしボタン
  if (event.type === 'postback') {
    await handleResumeAiPostback(event, tenant);
    return;
  }
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
        if (!session.displayName && (profile.customer.customer_name)) {
          session.displayName = (profile.customer.customer_name);
          setDisplayName(userId, (profile.customer.customer_name));
        }
        console.log(`[Freelance] 顧客特定: ${(profile.customer.customer_name)}`);
        // 監査ログ: AIによる顧客カルテ参照
        logCustomerAccess({
          action: 'customer_view',
          actor: 'ai',
          customerId: profile.customer.id,
          details: { context: 'chat_lookup', lineUserId: userId, tenantId: tenant.id },
        }).catch(() => {});
      }
    } catch (err) {
      console.warn('[Freelance] 顧客検索エラー:', err.message);
    }
  }

  // スタッフ引き継ぎ済みの場合 → 15分超なら自動解除、それ以外は分類して処理
  if (session.status === 'handoff_to_staff') {
    if (!maybeAutoReleaseHandoff(session)) {
      await handleHandoffModeMessage(session, tenant, userId, userMessage, replyToken, isImage, imageUrl);
      return;
    }
  }

  // ─── staff_active 排他制御（mycon スタッフが先制介入したケース） ───
  // status は counseling のまま（linking 中などの可能性）だが staff が mycon で返信済み。
  // AI も linking も走らせず、お客様の発話だけは必ず DB に残す。
  if (isStaffActive(session)) {
    console.log(`[Freelance] ${userId} staff_active: AI/linking 停止・メッセージログのみ保存`);
    await saveConversationLog({
      tenantId: tenant.id,
      customerId: session.customerProfile?.customer?.id || null,
      lineUserId: userId,
      customerMessage: userMessage,
      aiResponse: '（スタッフ対応中・AI停止）',
      messageType: isImage ? 'image' : 'text',
      imageUrl,
      timestamp: new Date(),
    });
    return;
  }

  // ─── 顧客紐づけフロー（未紐づけのお客様のみ） ───
  // 画像メッセージ中は紐づけフローに乗せない（テキストの返答が必要なため）
  if (!session.customerProfile && !isImage) {
    const linkingHelpers = {
      sendReply: async (text) => {
        try {
          await replyToLineWithClient(replyToken, text, tenant);
          // 会話ログに保存
          await saveConversationLog({
            tenantId: tenant.id,
            customerId: null,
            lineUserId: userId,
            customerMessage: userMessage,
            aiResponse: text,
            messageType: 'text',
            timestamp: new Date(),
          });
        } catch (err) {
          console.warn('[Linking] 返信失敗:', err.message);
        }
      },
      setDisplayName: (name) => {
        session.displayName = name;
        setDisplayName(userId, name);
      },
      setCustomerProfile: (profile) => {
        session.customerProfile = profile;
      },
      markEscalated: () => {
        setStatus(userId, 'handoff_to_staff');
        patchSession(userId, {
          conversationState: 'handoff_pending',
          handoffStartedAt: Date.now(),
        });
        scheduleHandoffSla(session, tenant);
      },
    };

    const linkResult = await runLinkingFlow(session, userId, userMessage, linkingHelpers);
    if (linkResult.handled) {
      console.log(`[Linking] ${userId} 紐づけフロー継続 state=${session.linking?.state}`);
      return;
    }
    // handled=false なら紐づけフロー外 → 通常AIへフォールスルー

    // 紐づけ完了直後：originalIntent があれば元の用件でAI応答する
    if (linkResult.linked && linkResult.originalIntent) {
      userMessage = linkResult.originalIntent;
      console.log(`[Linking] ${userId} 紐づけ完了 → originalIntent="${userMessage}" でAI応答`);
    }
  }

  // 会話履歴にユーザーメッセージ追加
  addMessage(userId, 'user', userMessage);

  // 二重ガード: ここまで来た時点で staff_active なら AI を喋らせない
  if (isStaffActive(session)) {
    console.log(`[Freelance] ${userId} staff_active 二重ガード発動: AI発話停止`);
    await saveConversationLog({
      tenantId: tenant.id,
      customerId: session.customerProfile?.customer?.id || null,
      lineUserId: userId,
      customerMessage: userMessage,
      aiResponse: '（スタッフ対応中・AI停止）',
      messageType: isImage ? 'image' : 'text',
      imageUrl,
      timestamp: new Date(),
    });
    return;
  }

  // AIカウンセリング応答生成
  try {
    // 生成と並行して即座に「考えてる感」を出す（最低5秒のローディング）
    showTypingIndicator(tenant, userId, 5000).catch(() => {});

    const genStart = Date.now();
    const aiResponse = await generateFreelanceResponse(session, tenant);
    const genElapsed = Date.now() - genStart;

    // [HANDOFF] タグの処理
    const needsHandoff = aiResponse.includes('[HANDOFF]');
    const cleanResponse = aiResponse.replace(/\[HANDOFF\]/g, '').trim();

    // 会話履歴にAI応答を追加
    addMessage(userId, 'assistant', cleanResponse);

    // 「考えてる感」の遅延を計算（生成にかかった時間は差し引く）
    const hourJST = getJstHourForDelay();
    const targetDelayMs = computeReplyDelayMs(cleanResponse, hourJST);
    const remainingDelay = Math.max(0, targetDelayMs - genElapsed);

    if (remainingDelay > 0) {
      // 遅延中はインジケーターを再延長（残り遅延に合わせる）
      showTypingIndicator(tenant, userId, remainingDelay).catch(() => {});
      console.log(`[Freelance Delay] len=${cleanResponse.length} hourJST=${hourJST} target=${targetDelayMs}ms gen=${genElapsed}ms wait=${remainingDelay}ms`);
      await sleep(remainingDelay);
    } else {
      console.log(`[Freelance Delay] 生成に${genElapsed}ms掛かったため遅延スキップ (target=${targetDelayMs}ms)`);
    }

    // LINE返信（引き継ぎ時はクイックリプライ付き）
    const replyOpts = needsHandoff ? { quickReply: HANDOFF_QUICK_REPLY } : {};
    await replyToLineWithClient(replyToken, cleanResponse, tenant, replyOpts);

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

    // 監査ログ: AI応答
    logCustomerAccess({
      action: 'ai_response',
      actor: 'ai',
      customerId: session.customerProfile?.customer?.id || null,
      details: {
        lineUserId: userId,
        tenantId: tenant.id,
        responseLength: cleanResponse.length,
        isHandoff: needsHandoff,
      },
    }).catch(() => {});

    // 引き継ぎが必要な場合、本人に通知
    if (needsHandoff) {
      setStatus(userId, 'handoff_to_staff');

      // 引き継ぎ状態の初期化
      patchSession(userId, {
        conversationState: 'handoff_pending',
        handoffStartedAt: Date.now(),
        staffLastResponseAt: null,
        holdingMessageSent: false,
      });
      console.log(`[Handoff State] ${userId} → handoff_pending`);

      // 監査ログ: スタッフ引き継ぎ
      logCustomerAccess({
        action: 'staff_handoff',
        actor: 'staff:auto',
        customerId: session.customerProfile?.customer?.id || null,
        details: { lineUserId: userId, tenantId: tenant.id, reason: 'ai_triggered' },
      }).catch(() => {});

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

      // SLAタイマー開始（5分:Slack再通知 / 10分:お客様へ業務的一次受け / 20分:エスカレーション）
      scheduleHandoffSla(session, tenant);
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

  // 過去のconversation_logsの有無で初回判定（現在のメッセージはまだ保存前）
  const hadPrior = await hasPriorConversation(session.userId);
  const userTurnCountForGreeting = session.conversationHistory.filter(m => m.role === 'user').length;
  // DBに過去ログなし かつ このセッション内でも初めてのuser発話（== 1）なら初回
  const isFirstContact = !hadPrior && userTurnCountForGreeting <= 1;

  const customerName =
    session.customerProfile?.customer?.customer_name ||
    session.customerProfile?.customer?.name ||
    session.displayName ||
    null;
  const originalIntent = session.linking?.originalIntent || null;
  let systemPrompt = buildFreelanceCounselingPrompt(tenant, karteContext, { isFirstContact, customerName, originalIntent });

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
// スタッフ名抽出用パターン（config/staff.jsと同期）
const STAFF_NAMES_FOR_HANDOFF = ['梶原', '梶原広樹', '森', '森美奈子', '大田', '大田夏帆', '渡邊', '渡邊達也', 'JUN', 'じゃっきー'];
const STAFF_MENTION_RE = new RegExp(
  `(${STAFF_NAMES_FOR_HANDOFF.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(さん|先生|くん)?`,
  'i'
);
const MENU_KEYWORDS = ['カット', 'カラー', 'パーマ', '縮毛矯正', 'トリートメント', 'ヘッドスパ', 'ストレート', 'ブリーチ', '白髪染め', 'リタッチ', 'ハイライト'];
const HAIR_RE = /(?:髪|毛先|根元|癖|くせ|ダメージ|パサ|ぱさ|量が多|量が少|薄|ボリューム|うねり|広がり|ゴワ|ごわ|絡まり|枝毛)/;

function buildFreelanceHandoffData(session) {
  const history = session.conversationHistory;

  // 顧客名: 紐づけ済みカルテ名 → LINE表示名 → デフォルト
  const customerName =
    session.customerProfile?.customer?.customer_name ||
    session.displayName ||
    'お客様';

  const customerMessages = history.filter(m => m.role === 'user').map(m => m.content);
  const allText = history.map(m => m.content).join(' ');
  const customerText = customerMessages.join(' ');

  // メニュー抽出（施術名キーワードのみ）
  const menuItems = MENU_KEYWORDS.filter(k => allText.includes(k));
  const menuStr = menuItems.length > 0 ? menuItems.join('・') : '未定';

  // 希望日時抽出
  let dateTime = '未定';
  const dateMatch = customerText.match(/(明日|明後日|来週|今週|今日|\d{1,2}月\d{1,2}日|\d{1,2}\/\d{1,2})/);
  if (dateMatch) dateTime = dateMatch[0];
  const timeMatch = customerText.match(/(\d{1,2}時(半)?|\d{1,2}:\d{2}|午前|午後)/);
  if (timeMatch) dateTime += ' ' + timeMatch[0];

  // 指名スタッフ抽出（「○○さん」「○○さんで」「○○さんお願い」等）
  const staffMatch = customerText.match(STAFF_MENTION_RE);
  const requestedStaff = staffMatch
    ? STAFF_NAMES_FOR_HANDOFF.find(n => staffMatch[0].startsWith(n)) || staffMatch[1]
    : '指名なし';

  // 髪の状態（お客様が髪について明確に述べた文のみ）
  const hairSentences = customerMessages
    .filter(m => HAIR_RE.test(m))
    .map(m => m.slice(0, 60));
  const hairCondition = hairSentences.length > 0 ? hairSentences.join('、') : '—';

  // カルテ情報（あれば追加）
  let karteNote = '';
  if (session.customerProfile) {
    const visits = session.customerProfile.visits || [];
    if (visits.length > 0) {
      const last = visits[0];
      const daysAgo = last.visited_at
        ? Math.floor((Date.now() - new Date(last.visited_at)) / (1000 * 60 * 60 * 24))
        : null;
      karteNote = daysAgo != null
        ? `前回来店: ${daysAgo}日前（${last.menu || '不明'}）`
        : '';
    }
  }

  // 会話ログ
  let conversationLog = '';
  for (const msg of history) {
    if (msg.role === 'user') {
      conversationLog += `👤 ${customerName}さま\n${msg.content}\n\n`;
    } else {
      conversationLog += `🤵 コンシェルジュ\n${msg.content}\n\n`;
    }
  }

  const summary = {
    customer: customerName,
    menu: menuStr,
    dateTime,
    staff: requestedStaff,
    hairCondition,
    karteNote,
  };

  const message = `📋 新しいお問い合わせ（AI引き継ぎ）
━━━━━━━━━━
👤 ${customerName}
✂️ メニュー: ${summary.menu}
📅 希望: ${summary.dateTime}
💇 指名: ${summary.staff}
💬 髪の状態: ${summary.hairCondition}
${karteNote ? `📝 カルテ: ${karteNote}\n` : ''}━━━━━━━━━━

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
// ─── クイックリプライ（引き継ぎ後 お客様→AIに戻す用） ───
// 「AIに相談する」は Postback にして、お客様の会話ログを「AIに相談したい」で汚さない
const HANDOFF_QUICK_REPLY = {
  items: [
    {
      type: 'action',
      action: {
        type: 'postback',
        label: '🤖 AIに相談する',
        data: 'action=resume_ai',
        displayText: 'AIに相談する',
      },
    },
    { type: 'action', action: { type: 'message', label: '担当を待つ', text: '担当の方を待ちます' } },
  ],
};
const AI_RETURN_RE = /AI(に|と)(相談|戻|もど)/i; // 後方互換: 旧QuickReply/自然文の両方を受ける
const WAIT_STAFF_RE = /担当.*(待ち|待つ|待って)/;

async function replyToLineWithClient(replyToken, text, tenant, opts = {}) {
  const client = getTenantLineClient(tenant);
  if (!client) {
    console.warn('[Freelance LINE Reply] クライアント未設定');
    return;
  }

  const msg = { type: 'text', text };
  if (opts.quickReply) msg.quickReply = opts.quickReply;

  try {
    await client.replyMessage({ replyToken, messages: [msg] });
    console.log(`[Freelance LINE Reply] 返信成功`);
  } catch (err) {
    console.error('[Freelance LINE Reply] 返信エラー:', err.message);
  }
}

async function pushWithQuickReply(userId, text, tenant, quickReply) {
  const client = getTenantLineClient(tenant);
  if (!client) return;
  const msg = { type: 'text', text };
  if (quickReply) msg.quickReply = quickReply;
  try {
    await client.pushMessage({ to: userId, messages: [msg] });
  } catch (err) {
    console.error('[LINE Push QR] 送信エラー:', err.message);
  }
}

module.exports = router;
module.exports.handleSlackReplyToLine = handleSlackReplyToLine;
module.exports.threadToLineUser = threadToLineUser;
