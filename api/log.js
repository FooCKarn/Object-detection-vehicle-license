// Forwards one plate reading from the demo page to the Google Apps Script web app
// bound to the LICENSE LOG sheet. The Apps Script URL and its shared secret stay
// server-side in the APPS_SCRIPT_URL and APPS_SCRIPT_SECRET environment variables
// (Vercel > Settings > Environment Variables). The reply carries the registration
// result: registered | blocked | expired | unregistered.
//
// When LINE_CHANNEL_ACCESS_TOKEN is set, a registered vehicle also sends a LINE message to the
// student's consenting guardians, and a blocked / expired / unregistered one alerts the
// security guards. Notification problems never fail the log write.

const { callScript, linePush } = require("./_shared");

const MAX_LICENSE = 20;
const MAX_PROVINCE = 40;
const BLOCKED_LABEL = { blocked: "ถูกระงับสิทธิ์", expired: "สิทธิ์หมดอายุ", unregistered: "ไม่ได้ลงทะเบียน" };

async function notify(data, license, province, gate) {
  const n = data.notify || {};
  const time = String(data.time || "").slice(11, 16);
  const messages = [];
  if (data.result === "registered") {
    const verb = gate === "out" ? "ออกจากวิทยาลัย" : gate === "in" ? "เข้าวิทยาลัย" : "ผ่านประตูวิทยาลัย";
    for (const to of n.recipients || []) messages.push([to, `${n.name || "นักเรียน"} ${verb} เวลา ${time} น.`]);
  } else if (BLOCKED_LABEL[data.result]) {
    const text = `⚠️ ตรวจพบรถ${BLOCKED_LABEL[data.result]}\nทะเบียน ${license} ${province}`.trim() + `\nเวลา ${time} น.`;
    for (const to of n.guards || []) messages.push([to, text]);
  }
  let sent = 0;
  for (const [to, text] of messages) {
    try { if (await linePush(to, text)) sent++; } catch { /* keep going */ }
  }
  return sent;
}

module.exports = async (req, res) => {
  const url = process.env.APPS_SCRIPT_URL;
  const secret = process.env.APPS_SCRIPT_SECRET;

  if (req.method === "GET") {
    return res.status(200).json({ configured: Boolean(url && secret) });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "method not allowed" });
  }
  if (!url || !secret) {
    return res.status(503).json({ ok: false, error: "APPS_SCRIPT_URL / APPS_SCRIPT_SECRET is not set" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const license = String((body && body.license) || "").trim().slice(0, MAX_LICENSE);
  const province = String((body && body.province) || "").trim().slice(0, MAX_PROVINCE);
  const gate = body && (body.gate === "in" || body.gate === "out") ? body.gate : "";
  if (!license) {
    return res.status(400).json({ ok: false, error: "license is required" });
  }

  let data;
  try {
    data = await callScript({ license, province });
  } catch (err) {
    return res.status(502).json({ ok: false, error: "could not reach Apps Script" });
  }
  if (!data.ok) return res.status(502).json({ ok: false, error: data.error || "Apps Script error" });

  let notified = 0;
  try { notified = await notify(data, license, province, gate); } catch { /* logging already succeeded */ }
  return res.status(200).json({ ok: true, id: data.id, time: data.time, result: data.result, notified });
};
