// ============================================
// server.js
// 美容室AI電話受付システム メインサーバー
// ============================================
require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { WebClient } = require("@slack/web-api");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const bodyParser = require("body-parser");

const { handleIncomingCall } = require("./callHandler");
const { handleIncomingSms } = require("./smsHandler");
const { handleSlackEvent } = require("./slackHandler");
const { generateResponse, clearHistory, getWelcomeMessage } = require("./ai-receptionist");
const KarteLookup = require("./karte-lookup");
const { getCustomerProfile, logCustomerAccess } = require("./supabase-client");
const lineWebhookRouter = require("./routes/line");
const { handleSlackReplyToLine, threadToLineUser } = require("./routes/line");
const apiRouter = require("./routes/api");
const registrationRouter = require("./routes/registration");

// カルテデータ読み込み
const karteLookup = new KarteLookup();
try {
  karteLookup.load();
} catch (err) {
  console.warn("[KarteLookup] CSV読み込みスキップ:", err.message);
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

// ─── Chat Config ───
const SALON_NAME = process.env.SALON_NAME || "美容室";
const slackWeb = new WebClient(process.env.SLACK_BOT_TOKEN);
const CHAT_SLACK_CHANNEL = process.env.SLACK_CHANNEL_ID;

// ─── Chat Sessions ───
// key: sessionId, value: { ws, phone, name, messages[], slackThreadTs, createdAt, mode }
// mode: 'ai' | 'staff' （デフォルト: 'ai'）
const chatSessions = new Map();

// ============================================
// ミドルウェア
// ============================================

// Slack署名検証用にrawBodyを保存
app.use(
  bodyParser.json({
    limit: '50mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ============================================
// ルーティング
// ============================================

// --- ヘルスチェック ---
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/", (_req, res) => {
  res.json({
    status: "running",
    service: "美容室AI電話受付システム",
    endpoints: {
      "POST /incoming-call": "Tasker電話着信",
      "POST /incoming-sms": "Tasker SMS受信",
      "POST /send-sms": "Slack経由SMS送信",
      "POST /slack/events": "Slack Events API",
      "POST /webhook/line": "LINE AIカウンセリング中継",
    },
  });
});

// --- Tasker 電話着信 ---
app.post("/incoming-call", handleIncomingCall);

// --- Tasker SMS受信 ---
app.post("/incoming-sms", handleIncomingSms);

// --- Slack Events ---
app.post("/slack/events", handleSlackEvent);

// --- LINE Webhook（AIカウンセリング中継） ---
app.use("/webhook/line", lineWebhookRouter);

// --- mycon 管理画面 API ---
app.use("/api", apiRouter);

// --- 顧客カルテ登録 API ---
app.use("/api/registration", registrationRouter);

// --- mycon 管理画面 静的ファイル ---
app.use("/app", express.static(path.join(__dirname, "public", "app")));

// /app のSPAフォールバック（サブパス対応）
app.get("/app/*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "app", "index.html"));
});

// --- AI Relay 自動起動（Gensparkからの命令受付） ---
const { exec } = require("child_process");
app.post("/run-relay", (req, res) => {
  console.log("🤖 Gensparkからの命令受信 → aiRelay.js起動");
  res.json({ status: "started", message: "aiRelay.js を起動しました" });
  exec("npm run ai:relay", (error, stdout, stderr) => {
    if (error) {
      console.error("❌ エラー:", error.message);
      return;
    }
    console.log("✅ aiRelay.js 完了:", stdout);
  });
});


// ============================================
// Webチャット ルーティング
// ============================================

// チャットページ表示
app.get("/chat/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  if (!chatSessions.has(sessionId)) {
    const phone = req.query.phone || "unknown";
    const session = {
      ws: null,
      phone,
      name: req.query.name || "お客様",
      messages: [],
      slackThreadTs: null,
      createdAt: new Date(),
      mode: "ai",
      karteContext: null,
      customerName: null,
      customerProfile: null,
    };

    // Supabase顧客検索
    if (phone !== "unknown") {
      try {
        const profile = await getCustomerProfile(phone, 'phone');
        if (profile) {
          session.customerProfile = profile;
          session.customerName = (profile.customer.customer_name || profile.customer.name);
          session.name = (profile.customer.customer_name || profile.customer.name);
          console.log(`[Supabase] 顧客特定: ${(profile.customer.customer_name || profile.customer.name)}`);
          logCustomerAccess({
            action: 'customer_view',
            actor: 'ai',
            customerId: profile.customer.id,
            details: { context: 'chat_lookup', sessionId, source: 'web_chat' },
          }).catch(() => {});
        }
      } catch (err) {
        console.warn('[Supabase] 検索エラー:', err.message);
      }
    }

    // Supabaseで見つからなければCSVカルテ検索（フォールバック）
    if (!session.customerProfile && phone !== "unknown" && karteLookup.loaded) {
      const ctx = karteLookup.buildContext(phone);
      if (ctx) {
        const karte = karteLookup.findByPhone(phone);
        session.karteContext = ctx;
        session.customerName = karte.name;
        session.name = karte.name;
        console.log(`[KarteLookup] 顧客特定: ${karte.name} (来店${karte.visitCount}回)`);
      }
    }

    chatSessions.set(sessionId, session);
    console.log(`[Chat] セッション作成: ${sessionId} / 名前: ${session.name} / カルテ: ${session.customerProfile ? 'Supabase' : session.karteContext ? 'CSV' : 'なし'}`);
  } else {
    console.log(`[Chat] 既存セッション使用: ${sessionId}`);
  }
  res.sendFile(path.join(__dirname, "public", "chat.html"));
});

// セッション情報取得
app.get("/api/session/:sessionId", (req, res) => {
  const session = chatSessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }
  res.json({
    name: session.name,
    messages: session.messages,
    salonName: SALON_NAME,
  });
});

// チャットセッション生成API（SMSフローから呼び出し）
app.post("/api/chat/create", async (req, res) => {
  const { phone, name } = req.body;
  const sessionId = uuidv4().split("-")[0];
  const session = {
    ws: null,
    phone: phone || "unknown",
    name: name || "お客様",
    messages: [],
    slackThreadTs: null,
    createdAt: new Date(),
    mode: "ai",
    karteContext: null,
    customerName: null,
    customerProfile: null,
  };

  // Supabase顧客検索
  if (phone) {
    try {
      const profile = await getCustomerProfile(phone, 'phone');
      if (profile) {
        session.customerProfile = profile;
        session.customerName = (profile.customer.customer_name || profile.customer.name);
        session.name = (profile.customer.customer_name || profile.customer.name);
        console.log(`[Supabase] 顧客特定: ${(profile.customer.customer_name || profile.customer.name)}`);
        logCustomerAccess({
          action: 'customer_view',
          actor: 'ai',
          customerId: profile.customer.id,
          details: { context: 'chat_lookup', sessionId, source: 'web_chat_create' },
        }).catch(() => {});
      }
    } catch (err) {
      console.warn('[Supabase] 検索エラー:', err.message);
    }
  }

  // Supabaseで見つからなければCSVカルテ検索（フォールバック）
  if (!session.customerProfile && phone && karteLookup.loaded) {
    const ctx = karteLookup.buildContext(phone);
    if (ctx) {
      const karte = karteLookup.findByPhone(phone);
      session.karteContext = ctx;
      session.customerName = karte.name;
      session.name = karte.name;
      console.log(`[KarteLookup] 顧客特定: ${karte.name}`);
    }
  }

  chatSessions.set(sessionId, session);
  const chatUrl = `${req.protocol}://${req.get("host")}/chat/${sessionId}`;
  res.json({ sessionId, chatUrl });
});

// Slackからチャットへの返信（/api/slack/message）
app.post("/api/slack/message", async (req, res) => {
  // Slack URL verification
  if (req.body.type === "url_verification") {
    return res.json({ challenge: req.body.challenge });
  }

  if (req.body.event && req.body.event.type === "message") {
    const event = req.body.event;

    // botメッセージは無視
    if (event.bot_id || event.subtype === "bot_message") {
      return res.sendStatus(200);
    }

    // ai:sessionId → AIモードに切替
    const aiMatch = event.text && event.text.match(/^ai:(\w+)$/);
    if (aiMatch) {
      const [, targetId] = aiMatch;
      const targetSession = chatSessions.get(targetId);
      if (targetSession) {
        targetSession.mode = "ai";
        notifyChatSlack(targetSession, "🔄 AIモードに切り替えました");
      }
      return res.sendStatus(200);
    }

    // staff:sessionId → スタッフモードに切替
    const staffMatch = event.text && event.text.match(/^staff:(\w+)$/);
    if (staffMatch) {
      const [, targetId] = staffMatch;
      const targetSession = chatSessions.get(targetId);
      if (targetSession) {
        targetSession.mode = "staff";
        clearHistory(targetId);
        notifyChatSlack(targetSession, "👋 スタッフモードに切り替えました");
      }
      return res.sendStatus(200);
    }

    // mode:sessionId → 現在のモード確認
    const modeMatch = event.text && event.text.match(/^mode:(\w+)$/);
    if (modeMatch) {
      const [, targetId] = modeMatch;
      const targetSession = chatSessions.get(targetId);
      if (targetSession) {
        const modeLabel = targetSession.mode === "ai" ? "🔄 AIモード" : "👋 スタッフモード";
        notifyChatSlack(targetSession, `現在のモード: ${modeLabel}`);
      }
      return res.sendStatus(200);
    }

    // reply:sessionId message 形式
    const replyMatch =
      event.text && event.text.match(/^reply:(\w+)\s+(.+)/s);
    if (replyMatch) {
      const [, sessionId, message] = replyMatch;
      sendToCustomer(sessionId, message);
      return res.sendStatus(200);
    }

    // スレッド返信 → 対応するセッションに転送（Webチャット）
    if (event.thread_ts) {
      let handled = false;
      for (const [sessionId, session] of chatSessions) {
        if (session.slackThreadTs === event.thread_ts) {
          sendToCustomer(sessionId, event.text);
          handled = true;
          break;
        }
      }

      // Webチャットで見つからなければ → LINE転送を試行
      if (!handled && event.channel) {
        handleSlackReplyToLine(event.channel, event.thread_ts, event.text).then((sent) => {
          if (sent) {
            console.log(`[Slack→LINE] スタッフ返信をLINEに転送: ch=${event.channel}`);
          }
        });
      }
    }
  }

  res.sendStatus(200);
});

// ─── WebSocket ───
wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get("sessionId");

  if (!sessionId || !chatSessions.has(sessionId)) {
    ws.close(4001, "Invalid session");
    return;
  }

  const session = chatSessions.get(sessionId);
  session.ws = ws;
  console.log(`[Chat WS] Customer connected: ${sessionId} / カルテ: ${session.karteContext ? 'あり' : 'なし'} / 名前: ${session.name}`);

  // 既存メッセージ履歴を送信
  if (session.messages.length > 0) {
    ws.send(JSON.stringify({ type: "history", messages: session.messages }));
  }

  // AIモードの場合、ウェルカムメッセージを送信（新規セッションのみ）
  if (session.mode === "ai" && session.messages.length === 0) {
    const welcome = getWelcomeMessage(session.customerName);
    const welcomeMsg = {
      id: uuidv4(),
      text: welcome,
      sender: "staff",
      timestamp: new Date().toISOString(),
    };
    session.messages.push(welcomeMsg);
    ws.send(JSON.stringify({ type: "message", message: welcomeMsg }));
  }

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "message") {
        const chatMessage = {
          id: uuidv4(),
          text: msg.text,
          image: msg.image || null,
          sender: "customer",
          timestamp: new Date().toISOString(),
        };
        session.messages.push(chatMessage);
        ws.send(JSON.stringify({ type: "message_ack", id: chatMessage.id }));

        // Slackに転送（記録用）
        await forwardToSlack(sessionId, session, chatMessage);

        // AIモードの場合、Claude APIでレスポンス生成
        if (session.mode === "ai") {
          const aiResponse = await generateResponse(sessionId, msg.text, session.karteContext, session.customerProfile);

          // AIの返信をお客様に送信
          sendToCustomer(sessionId, aiResponse.text);

          // AIの返信もSlackに記録
          await notifyChatSlack(
            session,
            `🤵 コンシェルジュ\n${aiResponse.text}`
          );

          // 引き継ぎが必要な場合
          if (aiResponse.needsHandoff) {
            session.mode = "staff";
            clearHistory(sessionId);

            // 議事録をSlackに投稿
            if (aiResponse.summary) {
              await notifyChatSlack(session, aiResponse.summary);
            }
            await notifyChatSlack(
              session,
              "👋 スタッフモードに切り替えました\n担当スタッフはこのスレッドで直接返信してください。"
            );
            console.log(
              `[AI Receptionist] Session ${sessionId} handed off to staff`
            );
          }
        }
        // スタッフモード: Slackに転送済みなのでそのまま
      }
    } catch (err) {
      console.error("[Chat WS] Message parse error:", err);
    }
  });

  ws.on("close", () => {
    console.log(`[Chat WS] Customer disconnected: ${sessionId}`);
    session.ws = null;
    clearHistory(sessionId);
    notifyChatSlack(session, "💤 お客様がチャットを閉じました");
  });

  notifyChatSlack(
    session,
    `🟢 お客様がチャットに接続しました`
  );
});

// ─── Chat → Slack ───
function isSlackConfigured() {
  return !!(process.env.SLACK_BOT_TOKEN && CHAT_SLACK_CHANNEL);
}

async function forwardToSlack(sessionId, session, message) {
  if (!isSlackConfigured()) {
    console.log("[Chat Slack] Slack未設定のためスキップ");
    return;
  }
  try {
    const text = message.image
      ? `📷 [画像送信]\n${message.text || ""}`
      : message.text;

    const slackMessage = `👤 ${session.name}（チャット）\n${text}`;

    if (session.slackThreadTs) {
      await slackWeb.chat.postMessage({
        channel: CHAT_SLACK_CHANNEL,
        text: slackMessage,
        thread_ts: session.slackThreadTs,
      });
    } else {
      const result = await slackWeb.chat.postMessage({
        channel: CHAT_SLACK_CHANNEL,
        text: slackMessage,
      });
      session.slackThreadTs = result.ts;
    }
  } catch (err) {
    console.error("[Chat Slack] Send error:", err.message);
  }
}

async function notifyChatSlack(session, notification) {
  if (!isSlackConfigured()) return;
  try {
    if (session.slackThreadTs) {
      await slackWeb.chat.postMessage({
        channel: CHAT_SLACK_CHANNEL,
        text: notification,
        thread_ts: session.slackThreadTs,
      });
    }
  } catch (err) {
    console.error("[Chat Slack] Notify error:", err.message);
  }
}

function sendToCustomer(sessionId, text) {
  const session = chatSessions.get(sessionId);
  if (!session) return;

  const chatMessage = {
    id: uuidv4(),
    text: text,
    sender: "staff",
    timestamp: new Date().toISOString(),
  };
  session.messages.push(chatMessage);

  if (session.ws && session.ws.readyState === WebSocket.OPEN) {
    session.ws.send(
      JSON.stringify({ type: "message", message: chatMessage })
    );
  }
}

// ─── セッションクリーンアップ（24時間で自動削除） ───
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of chatSessions) {
    if (now - session.createdAt.getTime() > 24 * 60 * 60 * 1000) {
      if (session.ws) session.ws.close();
      chatSessions.delete(id);
      console.log(`[Chat Cleanup] Removed session: ${id}`);
    }
  }
}, 60 * 60 * 1000);

// ============================================
// サーバー起動
// ============================================
server.listen(PORT, () => {
  console.log("");
  console.log("========================================");
  console.log("  美容室AI電話受付システム (Tasker版)");
  console.log("========================================");
  console.log(`  サーバー起動: http://localhost:${PORT}`);
  console.log("");
  console.log("  エンドポイント:");
  console.log(`    POST /incoming-call      → 電話着信 (Tasker)`);
  console.log(`    POST /incoming-sms       → SMS受信 (Tasker)`);
  console.log(`    POST /send-sms           → SMS送信 (Slack→Tasker)`);
  console.log(`    POST /slack/events       → Slack Events`);
  console.log(`    GET  /chat/:sessionId    → Webチャット`);
  console.log(`    POST /api/chat/create    → チャットセッション生成`);
  console.log(`    POST /api/slack/message  → Slack→チャット返信`);
  console.log(`    POST /webhook/line       → LINE AIカウンセリング中継`);
  console.log(`    GET  /app               → mycon 管理画面`);
  console.log(`    /api/*                  → mycon API`);
  console.log(`  サロン名: ${SALON_NAME}`);
  console.log("========================================");
  console.log("");

  // 環境変数チェック
  const required = [
    "TASKER_ENDPOINT_URL",
    "SLACK_BOT_TOKEN",
    "SLACK_CHANNEL_ID",
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.warn("⚠️  未設定の環境変数:");
    missing.forEach((key) => console.warn(`   - ${key}`));
    console.warn("   .env.example を参考に .env を設定してください");
    console.warn("");
  }
});
