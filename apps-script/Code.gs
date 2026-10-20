// Google Apps Script for the LICENSE LOG workbook.
//
// "LOG" sheet:               RECORD_ID | DATE_TIME | LICENSE | PROVINCE | RESULT
// "REGISTER_VEHICLE" sheet:  plate_number | province | student_id | status | expired_date
//   status: active | blocked   (anything else counts as not allowed)
//   province may be left empty to match any province; expired_date may be left empty for no expiry.
// "STUDENT_GUARDIAN" sheet:  student_id | student_name | bind_code | line_user_id | consent
//   One row per guardian. Staff fill student_id, student_name and bind_code (run generateBindCodes()
//   to fill empty codes; keep the bind_code column formatted as Plain text). The script fills
//   line_user_id and consent when a guardian registers on the LIFF page (or binds through the bot).
//   consent: pending (bound, not yet agreed) | yes | no
//   Rows with student_id = SECURITY receive alerts about blocked / expired / unregistered vehicles.
//
// Deploy: Extensions > Apps Script, paste this file, then Project Settings > Script properties,
// add SECRET = <long random string>. Deploy > New deployment > Web app, Execute as: Me,
// Who has access: Anyone. Put the /exec URL in Vercel as APPS_SCRIPT_URL and the same secret as
// APPS_SCRIPT_SECRET. Requests without the right secret are rejected.

const SHEET_NAME = "LOG";
const VEHICLES_SHEET = "REGISTER_VEHICLE";
const GUARDIAN_SHEET = "STUDENT_GUARDIAN";
const SECURITY_ID = "SECURITY";
const TIME_ZONE = "Asia/Bangkok";
const CACHE_SECONDS = 60;
const NOTIFY_QUIET_SECONDS = 600; // do not notify about the same student / plate again within 10 minutes
const MAX_BIND_FAILURES = 5;      // wrong bind codes allowed per LINE user per hour

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    if (!authorized_(body.secret)) return json_({ ok: false, error: "unauthorized" });

    switch (body.action) {
      case "bind": return json_(bind_(body.userId, body.code, false));
      case "register": return json_(bind_(body.userId, body.code, true));
      case "status": return json_(status_(body.userId));
      case "consent": return json_(setConsent_(body.userId, "yes"));
      case "unsubscribe": return json_(setConsent_(body.userId, "no"));
      default: return json_(logReading_(body));
    }
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return json_({ ok: true, service: "license-log" });
}

// ---------- plate log + registration check ----------

function logReading_(body) {
  const license = clean_(body.license, 20);
  const province = clean_(body.province, 40);
  if (!license) return { ok: false, error: "license is required" };

  const checked = check_(license, province);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
  const id = Math.max(1, sheet.getLastRow()); // row 1 is the header, so the first record gets ID 1
  const time = Utilities.formatDate(new Date(), TIME_ZONE, "yyyy-MM-dd HH:mm:ss");
  sheet.appendRow([id, time, license, province, checked.result]);
  return { ok: true, id: id, time: time, result: checked.result, notify: notify_(checked, license) };
}

// Who should hear about this reading. LINE user ids go back to the Vercel function, which holds
// the LINE token and sends the messages; they are never shown on the page.
function notify_(checked, license) {
  const cache = CacheService.getScriptCache();
  if (checked.result === "registered" && checked.studentId) {
    const key = "n:" + checked.studentId;
    if (cache.get(key)) return { recipients: [], name: "" };
    cache.put(key, "1", NOTIFY_QUIET_SECONDS);
    const rows = guardians_().filter(function (g) { return g.studentId === checked.studentId; });
    return {
      name: rows.length ? rows[0].name : "",
      recipients: rows.filter(consenting_).map(function (g) { return g.userId; }),
    };
  }
  const key = "g:" + normPlate_(license);
  if (cache.get(key)) return { guards: [] };
  cache.put(key, "1", NOTIFY_QUIET_SECONDS);
  return { guards: guardians_().filter(function (g) { return g.studentId === SECURITY_ID && consenting_(g); })
    .map(function (g) { return g.userId; }) };
}

// Fail closed: with no SECRET script property set, nothing is accepted.
function authorized_(given) {
  const secret = PropertiesService.getScriptProperties().getProperty("SECRET");
  return Boolean(secret) && String(given || "") === secret;
}

// { result: registered | blocked | expired | unregistered, studentId }
function check_(license, province) {
  const plate = normPlate_(license);
  const prov = normText_(province);
  const today = Utilities.formatDate(new Date(), TIME_ZONE, "yyyy-MM-dd");
  let result = "unregistered";
  let studentId = "";
  vehicles_().forEach(function (v) {
    if (normPlate_(v.plate) !== plate) return;
    if (v.province && prov && normText_(v.province) !== prov) return;
    if (v.status === "blocked") { result = "blocked"; return; }
    if (v.status !== "active") return;
    if (v.validUntil && v.validUntil < today) { if (result === "unregistered") result = "expired"; return; }
    if (result !== "blocked") { result = "registered"; studentId = v.studentId || ""; }
  });
  return { result: result, studentId: studentId };
}

function vehicles_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get("vehicles");
  if (hit) return JSON.parse(hit);
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(VEHICLES_SHEET);
  const rows = [];
  if (sheet && sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues().forEach(function (r) {
      if (!r[0]) return;
      rows.push({
        plate: String(r[0]),
        province: String(r[1] || ""),
        studentId: String(r[2] || "").trim(),
        status: String(r[3] || "").trim().toLowerCase(),
        validUntil: r[4] instanceof Date ? Utilities.formatDate(r[4], TIME_ZONE, "yyyy-MM-dd") : String(r[4] || "").trim(),
      });
    });
  }
  cache.put("vehicles", JSON.stringify(rows), CACHE_SECONDS);
  return rows;
}

// ---------- guardian binding (LINE bot) ----------

// Read the guardian sheet fresh each time (binding must see edits at once). `row` is the sheet row.
function guardians_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GUARDIAN_SHEET);
  const rows = [];
  if (sheet && sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues().forEach(function (r, i) {
      if (!r[0]) return;
      rows.push({
        row: i + 2,
        studentId: String(r[0]).trim(),
        name: String(r[1] || "").trim(),
        code: String(r[2] || "").trim().toUpperCase(),
        userId: String(r[3] || "").trim(),
        consent: String(r[4] || "").trim().toLowerCase(),
      });
    });
  }
  return rows;
}

function consenting_(g) { return g.consent === "yes" && g.userId !== ""; }

// A guardian sent their bind code: store their LINE userId on the matching row. From the bot the
// consent stays pending until they reply "ยินยอม"; the LIFF page asks for consent on the same form,
// so `agreed` sets it to yes at once.
function bind_(userId, code, agreed) {
  userId = String(userId || "").trim();
  code = String(code || "").trim().toUpperCase();
  if (!/^U[0-9a-f]{32}$/i.test(userId) || !code) return { ok: false, error: "bad_request" };

  const cache = CacheService.getScriptCache();
  const failKey = "bindfail:" + userId;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= MAX_BIND_FAILURES) return { ok: false, error: "locked" };

  const g = guardians_().filter(function (x) { return x.code === code; })[0];
  if (!g) {
    cache.put(failKey, String(fails + 1), 3600);
    return { ok: false, error: "not_found" };
  }
  if (g.userId && g.userId !== userId) return { ok: false, error: "already_bound" };

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GUARDIAN_SHEET);
  const consent = agreed || g.consent === "yes" ? "yes" : "pending";
  sheet.getRange(g.row, 4).setValue(userId);
  sheet.getRange(g.row, 5).setValue(consent);
  return { ok: true, name: g.name || g.studentId, consent: consent };
}

// Every student this LINE user is bound to, with that row's consent, for the LIFF page.
function status_(userId) {
  userId = String(userId || "").trim();
  if (!userId) return { ok: false, error: "bad_request" };
  const students = guardians_().filter(function (g) { return g.userId === userId; })
    .map(function (g) { return { name: g.name || g.studentId, consent: g.consent === "yes" ? "yes" : g.consent === "no" ? "no" : "pending" }; });
  return { ok: true, students: students };
}

// "ยินยอม" -> yes, "ยกเลิก" -> no, for every row bound to this LINE user.
function setConsent_(userId, value) {
  userId = String(userId || "").trim();
  const mine = guardians_().filter(function (g) { return g.userId === userId; });
  if (!userId || !mine.length) return { ok: false, error: "not_bound" };
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GUARDIAN_SHEET);
  mine.forEach(function (g) { sheet.getRange(g.row, 5).setValue(value); });
  return { ok: true, names: mine.map(function (g) { return g.name || g.studentId; }) };
}

// Run once from the editor (Run > generateBindCodes) to fill every empty bind_code cell with a
// random 6-character code (no 0/O/1/I). Then hand each guardian their code.
function generateBindCodes() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GUARDIAN_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return;
  const range = sheet.getRange(2, 3, sheet.getLastRow() - 1, 1);
  range.setNumberFormat("@");
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const used = {};
  range.getValues().forEach(function (r) { if (r[0]) used[String(r[0]).toUpperCase()] = true; });
  const out = range.getValues().map(function (r) {
    if (r[0]) return [r[0]];
    let c;
    do {
      c = "";
      for (let i = 0; i < 6; i++) c += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    } while (used[c]);
    used[c] = true;
    return [c];
  });
  range.setValues(out);
}

// ---------- helpers ----------

function normPlate_(s) { return String(s || "").replace(/[\s\-–.]/g, ""); }
function normText_(s) { return String(s || "").replace(/\s/g, ""); }

// Trim, cap length, and stop text that starts with = + - @ from being read as a formula.
function clean_(value, max) {
  let s = String(value || "").trim().slice(0, max);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
