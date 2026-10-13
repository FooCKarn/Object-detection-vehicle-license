// LINE Messaging API webhook. A guardian adds the official account, sends the bind code the
// college gave them, and replies "ยินยอม" to consent. The sender's LINE userId is read from the
// event and written to the STUDENT_GUARDIAN sheet by the Apps Script, so nobody types a LINE ID.
//
// Env: LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, APPS_SCRIPT_URL, APPS_SCRIPT_SECRET.
// LINE Developers Console > Messaging API > Webhook URL: https://<site>/api/line-webhook

const crypto = require("crypto");
const { callScript, lineReply } = require("./_shared");

const HELP = "สวัสดีครับ นี่คือระบบแจ้งเตือนการเข้า-ออกวิทยาลัย V-Gate\n" +
  "พิมพ์รหัสผูกบัญชี 6 หลักที่วิทยาลัยให้ไว้ เพื่อเริ่มรับแจ้งเตือน\n" +
  "พิมพ์ \"ยกเลิก\" เพื่อหยุดรับแจ้งเตือน";
const ERRORS = {
  not_found: "ไม่พบรหัสนี้ กรุณาตรวจสอบรหัสอีกครั้ง",
  locked: "พิมพ์รหัสผิดหลายครั้ง กรุณาลองใหม่ภายหลัง หรือติดต่อวิทยาลัย",
  already_bound: "รหัสนี้ถูกผูกกับบัญชี LINE อื่นแล้ว กรุณาติดต่อวิทยาลัย",
  not_bound: "ยังไม่ได้ผูกบัญชี กรุณาพิมพ์รหัสผูกบัญชีก่อน",
};

// Vercel must not parse the body: the signature is computed over the exact raw bytes.
module.exports.config = { api: { bodyParser: false } };

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function validSignature(raw, signature, secret) {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(raw).digest();
  const given = Buffer.from(String(signature), "base64");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

async function handleText(userId, text) {
  const t = text.trim();
  if (t === "ยกเลิก") {
    const d = await callScript({ action: "unsubscribe", userId });
    return d.ok ? "ยกเลิกการรับแจ้งเตือนแล้ว หากต้องการรับอีกครั้ง พิมพ์ \"ยินยอม\"" : (ERRORS[d.error] || HELP);
  }
  if (t === "ยินยอม") {
    const d = await callScript({ action: "consent", userId });
    if (!d.ok) return ERRORS[d.error] || "ทำรายการไม่สำเร็จ กรุณาลองใหม่";
    return `ยืนยันแล้ว จะแจ้งเตือนเมื่อ ${d.names.join(", ")} เข้า-ออกวิทยาลัย\nพิมพ์ "ยกเลิก" เมื่อต้องการหยุดรับแจ้งเตือน`;
  }
  if (/^[A-Za-z0-9]{6}$/.test(t)) {
    const d = await callScript({ action: "bind", userId, code: t });
    if (!d.ok) return ERRORS[d.error] || "ทำรายการไม่สำเร็จ กรุณาลองใหม่";
    return `พบข้อมูลของ ${d.name}\n` +
      "การแจ้งเตือนจะใช้ข้อมูลทะเบียนรถและเวลาเข้า-ออกวิทยาลัยของนักเรียน " +
      "หากผู้ปกครองยินยอม พิมพ์ \"ยินยอม\"";
  }
  return HELP;
}

module.exports = async (req, res) => {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (req.method === "GET") return res.status(200).json({ configured: Boolean(secret) });
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "method not allowed" });
  }
  if (!secret) return res.status(503).json({ ok: false, error: "LINE_CHANNEL_SECRET is not set" });

  const raw = await readRaw(req);
  if (!validSignature(raw, req.headers["x-line-signature"], secret)) {
    return res.status(401).json({ ok: false, error: "bad signature" });
  }

  let events = [];
  try { events = JSON.parse(raw.toString("utf8")).events || []; } catch { /* treat as no events */ }

  for (const ev of events) {
    const userId = ev.source && ev.source.userId;
    if (!userId || !ev.replyToken) continue;
    try {
      let reply = null;
      if (ev.type === "follow") reply = HELP;
      else if (ev.type === "message" && ev.message && ev.message.type === "text") reply = await handleText(userId, ev.message.text || "");
      if (reply) await lineReply(ev.replyToken, reply);
    } catch (err) {
      console.error("line-webhook event failed", err);
    }
  }
  return res.status(200).json({ ok: true });
};
