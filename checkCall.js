require("dotenv").config();
const twilio = require("twilio");

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

client
  .calls("CA1b90c5e42eeeaa93f2aec95e7ad82e03")
  .fetch()
  .then((call) => {
    console.log("Status:", call.status);
    console.log("Direction:", call.direction);
    console.log("Duration:", call.duration);
    console.log("Start:", call.startTime);
    console.log("End:", call.endTime);
    console.log("Price:", call.price);
    console.log("Error Code:", call.errorCode);
    console.log("Error Message:", call.errorMessage);
  })
  .catch((err) => {
    console.error("Error:", err.message);
  });
