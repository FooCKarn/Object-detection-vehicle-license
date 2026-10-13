// Helpers shared by the API functions (the leading underscore keeps Vercel from
// exposing this file as an endpoint).

const LINE_API = "https://api.line.me/v2/bot/message";

// POST one action to the Apps Script web app, adding the shared secret.
// Resolves to the parsed JSON reply; throws only when the network call fails.
async function callScript(payload) {
  const url = process.env.APPS_SCRIPT_URL;
  const secret = process.env.APPS_SCRIPT_SECRET;
  if (!url || !secret) return { ok: false, error: "APPS_SCRIPT_URL / APPS_SCRIPT_SECRET is not set" };
  // text/plain keeps Apps Script happy; it answers with a redirect that fetch follows.
  const upstream = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ ...payload, secret }),
    redirect: "follow",
  });
  const text = await upstream.text();
  try { return JSON.parse(text); } catch { return { ok: false, error: "unexpected reply from Apps Script" }; }
}

// Send a LINE message. Resolves to true when LINE accepted it, false otherwise
// (including when LINE_CHANNEL_ACCESS_TOKEN is not set).
async function lineSend(kind, body) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return false;
  const r = await fetch(`${LINE_API}/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return r.ok;
}

const linePush = (to, text) => lineSend("push", { to, messages: [{ type: "text", text }] });
const lineReply = (replyToken, text) => lineSend("reply", { replyToken, messages: [{ type: "text", text }] });

module.exports = { callScript, linePush, lineReply };
