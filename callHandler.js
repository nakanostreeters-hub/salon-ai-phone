// ============================================
// handlers/callHandler.js
// Twilio 電話着信 Webhook ハンドラー
// ============================================
const VoiceResponse = require("twilio").twiml.VoiceResponse;
const { sendSms } = require("./smsService");
const { notifySlack } = require("./slackService");

/**
 * 着信時の処理
 * 1. 録音音声を再生
 * 2. 通話終了後にSMS送信 + Slack通知
 */
function handleIncomingCall(req, res) {
  const twiml = new VoiceResponse();
  const callerNumber = req.body.From || "不明";

  console.log(`[着信] From: ${callerNumber}`);

  // --- 音声案内を再生 ---
  const greetingUrl = process.env.SALON_GREETING_URL;

  if (greetingUrl) {
    // 外部音声ファイルがある場合
    twiml.play(greetingUrl);
  } else {
    // 音声ファイルがない場合はTTS（テキスト読み上げ）
    twiml.say(
      {
        language: "ja-JP",
        voice: "Polly.Mizuki",
      },
      `お電話ありがとうございます。${process.env.SALON_NAME || "当店"}でございます。` +
        "ただいま電話に出ることができません。" +
        "このあとSMSをお送りしますので、ご用件をメッセージでお送りください。" +
        "折り返しご連絡いたします。"
    );
  }

  // 通話終了
  twiml.hangup();

  res.type("text/xml");
  res.send(twiml.toString());
}

/**
 * 通話ステータス変更時の処理（statusCallback）
 * 通話完了後にSMS送信 + Slack通知
 */
async function handleCallStatus(req, res) {
  const callStatus = req.body.CallStatus;
  const callerNumber = req.body.From || "不明";

  console.log(`[通話ステータス] ${callerNumber}: ${callStatus}`);

  if (callStatus === "completed") {
    try {
      // 顧客にSMS送信
      const smsBody =
        `${process.env.SALON_NAME || "当店"}にお電話いただきありがとうございます。\n\n` +
        "ご予約・お問い合わせはこのSMSに返信してください。\n" +
        "折り返しご連絡いたします。";

      await sendSms(callerNumber, smsBody);
      console.log(`[SMS送信完了] To: ${callerNumber}`);

      // Slackに通知
      await notifySlack({
        type: "call",
        from: callerNumber,
        message: "電話着信がありました。SMSを自動送信しました。",
      });
      console.log(`[Slack通知完了] 着信: ${callerNumber}`);
    } catch (error) {
      console.error("[通話後処理エラー]", error.message);
    }
  }

  res.sendStatus(200);
}

module.exports = { handleIncomingCall, handleCallStatus };
