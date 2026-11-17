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
  try { return JSON.parse(text); } catch { return { ok: false, error: describeHtml(upstream, text) }; }
}

// Apps Script answers with an HTML page (not JSON) when the script itself fails to load or run
// (syntax error, duplicate declarations, missing doPost), when the deployment needs sign-in or was
// deleted, or when Google rejects the call. Pull the readable part out so the page can say which.
function describeHtml(upstream, text) {
  const title = (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  const body = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
  const err = body.match(/(\w*Error:[^]{0,200}?\(line \d+[^)]*\))|(Script function not found: \w+)|(Exception:[^.]{0,200})/);
  let kind = "not_json";
  if (/accounts\.google\.com|ServiceLogin|Sign in/i.test(text)) kind = "signin";
  else if (upstream.status === 404 || /not found|could not be found|ไม่พบ/i.test(title)) kind = "not_found";
  else if (err) kind = "script_error";
  const detail = (err ? err[0] : title || body).slice(0, 220);
  return `unexpected reply from Apps Script [${kind}] (HTTP ${upstream.status}): ${detail}`;
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
