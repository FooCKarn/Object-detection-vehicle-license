// LINE Messaging API webhook. Guardians register and cancel on the LIFF page (liff/index.html) that
// the OA's rich menu opens, so the chat only carries notifications: a new follower gets one welcome
// message and any other text gets a short pointer to the menu.
//
// The old typed commands (bind code, then "ยินยอม"; "ยกเลิก") still work for guardians who started
// that way. Set LEGACY_CHAT_COMMANDS=off to drop them once everyone uses the menu.
//
// Env: LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, APPS_SCRIPT_URL, APPS_SCRIPT_SECRET, LIFF_ID.
// LINE Developers Console > Messaging API > Webhook URL: https://<site>/api/line-webhook

const crypto = require("crypto");
const { callScript, lineReply } = require("./_shared");

// With LIFF_ID set the messages also carry the links, for phones where the rich menu is hidden.
function liffLink(mode) {
  const id = process.env.LIFF_ID;
  return id ? `\nhttps://liff.line.me/${id}?mode=${mode}` : "";
}
const welcome = () => "สวัสดีครับ นี่คือระบบแจ้งเตือนการเข้า-ออกวิทยาลัย V-Gate\n" +
  "กดปุ่ม \"ลงทะเบียน\" ที่เมนูด้านล่าง แล้วกรอกรหัสผูกบัญชี 6 หลักที่วิทยาลัยให้ไว้" + liffLink("register");
const useMenu = () => "กรุณาใช้เมนูด้านล่างเพื่อลงทะเบียนหรือยกเลิกการแจ้งเตือน\n" +
  "แชตนี้ใช้สำหรับส่งแจ้งเตือนเท่านั้น" + liffLink("register");
const legacyOn = () => process.env.LEGACY_CHAT_COMMANDS !== "off";
const ERRORS = {
  not_found: "ไม่พบรหัสนี้ กรุณาตรวจสอบรหัสอีกครั้ง",
  locked: "พิมพ์รหัสผิดหลายครั้ง กรุณาลองใหม่ภายหลัง หรือติดต่อวิทยาลัย",
  already_bound: "รหัสนี้ถูกผูกกับบัญชี LINE อื่นแล้ว กรุณาติดต่อวิทยาลัย",
  not_bound: "ยังไม่ได้ลงทะเบียน กรุณากดปุ่ม \"ลงทะเบียน\" ที่เมนูด้านล่าง",
};

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
  if (!legacyOn()) return useMenu();
  if (t === "ยกเลิก") {
    const d = await callScript({ action: "unsubscribe", userId });
    return d.ok ? "ยกเลิกการรับแจ้งเตือนแล้ว หากต้องการรับอีกครั้ง กดปุ่ม \"ลงทะเบียน\" ที่เมนูด้านล่าง" : (ERRORS[d.error] || useMenu());
  }
  if (t === "ยินยอม") {
    const d = await callScript({ action: "consent", userId });
    if (!d.ok) return ERRORS[d.error] || "ทำรายการไม่สำเร็จ กรุณาลองใหม่";
    return `ยืนยันแล้ว จะแจ้งเตือนเมื่อ ${d.names.join(", ")} เข้า-ออกวิทยาลัย\nกดปุ่ม "ยกเลิกการแจ้งเตือน" ที่เมนูด้านล่างเมื่อต้องการหยุด`;
  }
  if (/^[A-Za-z0-9]{6}$/.test(t)) {
    const d = await callScript({ action: "bind", userId, code: t });
    if (!d.ok) return ERRORS[d.error] || "ทำรายการไม่สำเร็จ กรุณาลองใหม่";
    return `พบข้อมูลของ ${d.name}\n` +
      "การแจ้งเตือนจะใช้ข้อมูลทะเบียนรถและเวลาเข้า-ออกวิทยาลัยของนักเรียน " +
      "หากผู้ปกครองยินยอม พิมพ์ \"ยินยอม\"";
  }
  return useMenu();
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
      if (ev.type === "follow") reply = welcome();
      else if (ev.type === "message" && ev.message && ev.message.type === "text") reply = await handleText(userId, ev.message.text || "");
      if (reply) await lineReply(ev.replyToken, reply);
    } catch (err) {
      console.error("line-webhook event failed", err);
    }
  }
  return res.status(200).json({ ok: true });
};

// Vercel must not parse the body: the signature is computed over the exact raw bytes.
// (Set after module.exports is assigned, or the assignment above would discard it.)
module.exports.config = { api: { bodyParser: false } };
