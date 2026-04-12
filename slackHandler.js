// ============================================
// handlers/slackHandler.js
// Slack イベント ハンドラー
// ============================================
const crypto = require("crypto");
const { sendSms } = require("./smsService");

/**
 * Slackリクエストの署名検証
 */
function verifySlackSignature(req) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return true; // 開発時はスキップ可

  const timestamp = req.headers["x-slack-request-timestamp"];
  const slackSignature = req.headers["x-slack-signature"];

  // 署名ヘッダーがない場合はスキップ（ローカルテスト用）
  if (!timestamp || !slackSignature) return true;

  // 5分以上前のリクエストは拒否
  const fiveMinutes = 5 * 60;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > fiveMinutes) {
    return false;
  }

  const sigBasestring = `v0:${timestamp}:${req.rawBody}`;
  const mySignature =
    "v0=" +
    crypto
      .createHmac("sha256", signingSecret)
      .update(sigBasestring)
      .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(mySignature),
    Buffer.from(slackSignature)
  );
}

/**
 * Slack Events API エンドポイント
 * - URL検証（challenge）
 * - メッセージイベント処理
 */
async function handleSlackEvent(req, res) {
  const payload = req.body;

  // --- URL検証 (Slack App設定時に必要) ---
  if (payload.type === "url_verification") {
    console.log("[Slack] URL検証リクエスト");
    return res.json({ challenge: payload.challenge });
  }

  // --- 署名検証 ---
  if (!verifySlackSignature(req)) {
    console.error("[Slack] 署名検証失敗");
    return res.sendStatus(401);
  }

  // --- イベント処理 ---
  if (payload.type === "event_callback") {
    const event = payload.event;

    // botのメッセージは無視（無限ループ防止）
    if (event.bot_id || event.subtype === "bot_message") {
      return res.sendStatus(200);
    }

    // reply:コマンドを処理（スレッド返信またはチャンネル直接投稿）
    if (event.type === "message") {
      await handleSlackReply(event);
    }
  }

  res.sendStatus(200);
}

/**
 * Slackメッセージ → Tasker経由SMS送信
 * フォーマット: "reply:+8190XXXXXXXX メッセージ本文"
 */
async function handleSlackReply(event) {
  const replyText = event.text || "";

  console.log(`[Slack返信] Text: ${replyText}`);

  const replyMatch = replyText.match(/^reply:(\+?\d+)\s+(.+)$/s);

  if (replyMatch) {
    const phoneNumber = replyMatch[1];
    const messageBody = replyMatch[2];

    try {
      await sendSms(phoneNumber, messageBody);
      console.log(`[SMS送信完了] Slack経由 → ${phoneNumber}`);
      await postToSlack(event.channel, `💇 スタッフ\nSMS送信完了 → ${phoneNumber}`);
    } catch (error) {
      console.error("[SMS送信エラー]", error.message);
      await postToSlack(event.channel, `❌ SMS送信失敗\n${error.message}`);
    }
  } else {
    console.log(
      "[Slack返信] 電話番号が見つかりません。形式: reply:+8190XXXXXXXX メッセージ"
    );
  }
}

/**
 * Slackチャンネルにメッセージを投稿
 */
async function postToSlack(channel, text) {
  const { WebClient } = require("@slack/web-api");
  const client = new WebClient(process.env.SLACK_BOT_TOKEN);
  await client.chat.postMessage({ channel, text });
}

module.exports = { handleSlackEvent };
