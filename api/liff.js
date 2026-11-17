// Backend for the LIFF registration page (liff/index.html). The page sends the LIFF ID token it got
// from LINE; this function checks the token with LINE and takes the guardian's userId from it, so a
// page can never act for somebody else's LINE account. The sheet work is done by the Apps Script.
//
// GET  -> { liffId } so the page knows which LIFF app to start.
// POST { idToken, action: status | preview | register | resume | cancel, studentId?, code? }
//   preview  { studentId }          -> masked name to confirm, how many other accounts follow them
//   register { studentId } or { code } (the old 6-character bind code still works, e.g. for guards)
//   resume / cancel { studentId? }   -> one child, or every child when studentId is left out
//
// Env: LIFF_ID, LINE_LOGIN_CHANNEL_ID (the LINE Login channel that owns the LIFF app; it must be in the
// same provider as the Messaging API channel, or the userId will not match the OA's),
// APPS_SCRIPT_URL, APPS_SCRIPT_SECRET, and LINE_CHANNEL_ACCESS_TOKEN for the confirmation message.

const { callScript, linePush } = require("./_shared");

const VERIFY_URL = "https://api.line.me/oauth2/v2.1/verify";
const SCRIPT_ACTION = { status: "status", preview: "preview", register: "register", resume: "consent", cancel: "unsubscribe" };
// Replies the Apps Script gives on purpose; anything else means it is missing or an old version.
const KNOWN_ERRORS = ["not_found", "locked", "already_bound", "not_bound", "bad_student", "full"];

// Resolves to the LINE userId in a valid ID token for our channel, or "" when the token is bad.
async function verifiedUserId(idToken, channelId) {
  if (!idToken) return "";
  const r = await fetch(VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: String(idToken), client_id: channelId }).toString(),
  });
  if (!r.ok) return "";
  const t = await r.json().catch(() => ({}));
  return typeof t.sub === "string" && /^U[0-9a-f]{32}$/i.test(t.sub) ? t.sub : "";
}

function confirmation(action, data) {
  if (action === "register" && data.consent === "wait")
    return `ส่งคำขอรับแจ้งเตือนของ ${data.name} แล้ว รอวิทยาลัยอนุมัติ`;
  if (action === "register") return `ลงทะเบียนสำเร็จ จะแจ้งเตือนเมื่อ ${data.name} เข้า-ออกวิทยาลัย`;
  if (action === "resume") return data.names.length ? `เปิดรับแจ้งเตือนอีกครั้งแล้ว สำหรับ ${data.names.join(", ")}` : "";
  if (action === "cancel") return data.names.length
    ? `ยกเลิกการรับแจ้งเตือนของ ${data.names.join(", ")} แล้ว เปิดอีกครั้งได้จากเมนูด้านล่าง` : "";
  return "";
}

// Sent to the guardians a student already has, so a stranger who signs up with a known student ID
// does not go unnoticed.
const joinedNotice = (name) => `แจ้งเพื่อทราบ: มีบัญชี LINE อีก 1 บัญชีลงทะเบียนรับแจ้งเตือนการเข้า-ออกวิทยาลัยของ ${name}` +
  "\nหากไม่ใช่ผู้ปกครองหรือคนในครอบครัว กรุณาแจ้งวิทยาลัยเพื่อลบออก";

// Student IDs are 11 digits (as in the Student sheet); people paste them with spaces or dashes.
const cleanStudentId = (v) => String(v || "").replace(/[\s-]/g, "");

module.exports = async (req, res) => {
  const liffId = process.env.LIFF_ID || "";
  const channelId = process.env.LINE_LOGIN_CHANNEL_ID;
  if (req.method === "GET") return res.status(200).json({ liffId, configured: Boolean(liffId && channelId) });
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "method not allowed" });
  }
  if (!channelId) return res.status(503).json({ ok: false, error: "not_ready" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};
  const action = String(body.action || "");
  if (!SCRIPT_ACTION[action]) return res.status(400).json({ ok: false, error: "bad_request" });
  const code = String(body.code || "").trim().toUpperCase();
  const studentId = cleanStudentId(body.studentId);
  if (studentId && !/^[0-9]{11}$/.test(studentId)) return res.status(400).json({ ok: false, error: "bad_student" });
  if (action === "preview" && !studentId) return res.status(400).json({ ok: false, error: "bad_student" });
  if (action === "register" && !studentId && !/^[A-Z0-9]{6}$/.test(code)) return res.status(400).json({ ok: false, error: "bad_code" });

  let userId;
  try { userId = await verifiedUserId(body.idToken, channelId); } catch { userId = ""; }
  if (!userId) return res.status(401).json({ ok: false, error: "bad_token" });

  let data;
  try {
    data = await callScript({ action: SCRIPT_ACTION[action], userId, code: studentId ? "" : code, studentId });
  } catch {
    return res.status(502).json({ ok: false, error: "not_ready" });
  }
  if (!data.ok) {
    const error = KNOWN_ERRORS.includes(data.error) ? data.error : "not_ready";
    return res.status(error === "not_ready" ? 502 : 200).json({ ok: false, error });
  }
  if (action === "status") {
    if (!Array.isArray(data.students)) return res.status(502).json({ ok: false, error: "not_ready" });
    return res.status(200).json({ ok: true, students: data.students });
  }
  if (action === "preview") {
    if (typeof data.name !== "string") return res.status(502).json({ ok: false, error: "not_ready" });
    return res.status(200).json({ ok: true, studentId: data.studentId, name: data.name, already: data.already || "",
      others: Number(data.others) || 0, approval: Boolean(data.approval) });
  }

  const text = confirmation(action, data);
  try { if (text) await linePush(userId, text); } catch { /* the page shows the result anyway */ }
  if (action === "register" && Array.isArray(data.notify)) {
    await Promise.all(data.notify.filter((id) => id !== userId)
      .map((id) => linePush(id, joinedNotice(data.name)).catch(() => false)));
  }
  return res.status(200).json({ ok: true, name: data.name, names: data.names, consent: data.consent });
};
