require("dotenv").config();
const twilio = require("twilio");

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

client.calls
  .create({
    to: "+818058864043",
    from: "+19784048363",
    url: "https://handler.twilio.com/twiml/EH4adb1113bd4c92eeded3eccfec651bf7",
  })
  .then((call) => {
    console.log("通話発信成功! Call SID:", call.sid);
  })
  .catch((err) => {
    console.error("通話発信エラー:", err.message);
  });
