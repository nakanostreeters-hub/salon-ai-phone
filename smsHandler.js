// ============================================
// handlers/smsHandler.js
// Twilio SMS受信 Webhook ハンドラー
// ============================================
const MessagingResponse = require("twilio").twiml.MessagingResponse;
const { notifySlack } = require("./slackService");

/**
 * 顧客からのSMS受信時の処理
 * 1. Slackに通知
 * 2. 自動返信SMS送信
 */
async function handleIncomingSms(req, res) {
  const from = req.body.From || "不明";
  const body = req.body.Body || "";

  console.log(`[SMS受信] From: ${from} | Body: ${body}`);

  try {
    // Slackに通知（顧客の電話番号とメッセージ内容）
    await notifySlack({
      type: "sms",
      from: from,
      message: body,
    });
    console.log(`[Slack通知完了] SMS: ${from}`);
  } catch (error) {
    console.error("[Slack通知エラー]", error.message);
  }

  // 自動返信（TwiML）
  const twiml = new MessagingResponse();
  twiml.message(
    "メッセージを受け付けました。スタッフが確認次第ご連絡いたします。"
  );

  res.type("text/xml");
  res.send(twiml.toString());
}

module.exports = { handleIncomingSms };
