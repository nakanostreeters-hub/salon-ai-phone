require("dotenv").config();
const twilio = require("twilio");

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

client.messages
  .create({
    to: "+818058864043",
    from: "+19784048363",
    body: "お電話ありがとうございます。\nこちらは【premier models中野】です。\n当店では、テキストで残せるようにSMSでのやり取りでお客様の対応を行なっております。\nこちらにlineで返信するようにメッセージをお送りくださいませ🙇‍♂️\nスタッフがリアルタイムでやり取りをいたします😃",
  })
  .then((msg) => {
    console.log("SMS送信成功! SID:", msg.sid);
  })
  .catch((err) => {
    console.error("SMS送信エラー:", err.message);
  });
