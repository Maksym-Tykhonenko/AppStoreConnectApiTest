// ---------------------------------------------------------------------------
// telegram.js
// ---------------------------------------------------------------------------
// Sends messages to a Telegram bot (used by the version-status monitor).
//
// To send via the Telegram Bot API you need TWO things:
//   MAX_T_TELEGREM_BOT = the BOT TOKEN from @BotFather  (e.g. 123456789:AA...)
//   TELEGRAM_CHAT_ID   = the chat id to send to         (e.g. 12345678 or @channel)
//
// A bot @username is NOT enough. You can also put both in one var as
// "TOKEN|CHATID" if you prefer a single line.
//
// Messages are sent DIRECTLY (not through PROXY_URL), so notifications still
// work even when the Apple proxy is failing.
// ---------------------------------------------------------------------------

const axios = require("axios");

function getConfig() {
  // Accept the token under any of these names (whichever you set in .env).
  let token = (
    process.env.TELEGRAM_BOT_TOKEN ||
    process.env.TELEGREM_BOT_TOKEN ||
    process.env.MAX_T_TELEGREM_BOT ||
    ""
  ).trim();
  let chatId = (process.env.TELEGRAM_CHAT_ID || "").trim();
  // Allow "TOKEN|CHATID" in the single var.
  if (token.includes("|")) {
    const i = token.lastIndexOf("|");
    if (!chatId) chatId = token.slice(i + 1).trim();
    token = token.slice(0, i).trim();
  }
  return { token, chatId };
}

// A bot token looks like "123456789:AA...". A "@username" is not a token.
function tokenLooksValid(token) {
  // "<digits>:<secret>" — rejects a @username, accepts real tokens.
  return /^\d+:\S{20,}$/.test(token);
}

// Returns { ok } or { ok:false, reason } explaining what's missing.
function status() {
  const { token, chatId } = getConfig();
  if (!token) {
    return { ok: false, reason: "MAX_T_TELEGREM_BOT (bot token) is empty." };
  }
  if (!tokenLooksValid(token)) {
    return {
      ok: false,
      reason:
        "MAX_T_TELEGREM_BOT is not a bot token — put the token from @BotFather " +
        "(looks like 123456789:AA...), not a @username.",
    };
  }
  if (!chatId) {
    return { ok: false, reason: "TELEGRAM_CHAT_ID is not set." };
  }
  return { ok: true };
}

function isConfigured() {
  return status().ok;
}

/** Send a message. Throws with a clear reason if not configured / on API error. */
async function notify(text) {
  const s = status();
  if (!s.ok) throw new Error(s.reason);
  const { token, chatId } = getConfig();
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await axios.post(
    url,
    {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    },
    { timeout: 15000, proxy: false }
  );
  return res.data;
}

module.exports = { isConfigured, status, notify, getConfig };
