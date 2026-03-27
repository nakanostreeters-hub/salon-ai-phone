// ============================================
// handlers/smsHandler.js
// Tasker SMS受信ハンドラー
// ============================================
const { notifySlack } = require("./slackService");

/**
 * TaskerからのSMS受信通知を処理
 * POST /incoming-sms
 * Body: { from: "+81xxxxxxxxxx", body: "メッセージ", timestamp: number }
 */
async function handleIncomingSms(req, res) {
  const { from, body } = req.body;

  console.log(`[SMS受信] From: ${from} | Body: ${body}`);

  try {
    await notifySlack({
      type: "sms",
      from,
      message: `💬 ${from} からSMS受信:\n${body}\n返信: reply:${from} 返信内容`,
    });
    console.log(`[Slack通知完了] SMS: ${from}`);
    res.json({ status: "ok" });
  } catch (error) {
    console.error("[Slack通知エラー]", error.message);
    res.status(500).json({ status: "error", message: error.message });
  }
}

module.exports = { handleIncomingSms };
