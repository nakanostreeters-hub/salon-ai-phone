// ============================================
// services/smsService.js
// Twilio SMS送信サービス
// ============================================
const twilio = require("twilio");

let client = null;

/**
 * Twilioクライアント初期化（遅延初期化）
 */
function getClient() {
  if (!client) {
    client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  }
  return client;
}

/**
 * SMS送信
 * @param {string} to - 送信先電話番号（+81形式）
 * @param {string} body - メッセージ本文
 * @returns {Promise<object>} Twilioメッセージオブジェクト
 */
async function sendSms(to, body) {
  const twilioClient = getClient();

  const message = await twilioClient.messages.create({
    body: body,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: to,
  });

  console.log(`[SMS] SID: ${message.sid} | To: ${to}`);
  return message;
}

module.exports = { sendSms };
