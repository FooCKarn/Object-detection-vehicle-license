// Google Apps Script for the LICENSE LOG workbook.
//
// "LOG" sheet:               RECORD_ID | DATE_TIME | LICENSE | PROVINCE | RESULT | STUDENT_ID
// "REGISTER_VEHICLE" sheet:  plate_number | province | student_id | status | expired_date
//   status: active | blocked   (anything else counts as not allowed)
//   province may be left empty to match any province; expired_date may be left empty for no expiry.
// "Student" sheet (also read as "Data Student"): every student in the college. Columns are found
//   by header: student_id, GroupCode, กลุ่มเรียน, student_name.
// "GroupCode" sheet: one row per study group. Columns found by header: รหัสกลุ่มเรียน,
//   ชื่อกลุ่มเรียน, ชื่อย่อกลุ่มเรียน, ครูที่ปรึกษา. A student's GroupCode points at รหัสกลุ่มเรียน.
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
const STUDENT_SHEETS = ["Data Student", "Student"];
const GROUP_SHEET = "GroupCode";
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
      case "lookup": return json_(lookup_(body));
      case "summary": return json_(summary_(body));
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
  sheet.appendRow([id, time, license, province, checked.result, checked.ownerId]);
  return { ok: true, id: id, time: time, result: checked.result, student: student_(checked.ownerId),
    notify: notify_(checked, license) };
}

// Registration check only, for the page's green / red badge: nothing is logged and nobody is notified.
// The plate comes in `plate` (not `license`) so an older deployment refuses it instead of logging it.
function lookup_(body) {
  const plate = clean_(body.plate, 20);
  if (!plate) return { ok: false, error: "plate is required" };
  const checked = check_(plate, clean_(body.province, 40));
  return { ok: true, result: checked.result, student: student_(checked.ownerId) };
}

// LOG rows for the dashboard page: every reading from the last `days` days (1-90), oldest first,
// as [id, "yyyy-MM-dd HH:mm:ss", license, province, result, studentId], plus student details for
// the newest readings only. Read-only: nothing is logged and nobody is notified.
const SUMMARY_MAX_DAYS = 90;
const SUMMARY_RECENT = 30;
function summary_(body) {
  const days = Math.max(1, Math.min(SUMMARY_MAX_DAYS, Math.floor(Number(body.days) || 30)));
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
  const from = Utilities.formatDate(new Date(Date.now() - (days - 1) * 86400000), TIME_ZONE, "yyyy-MM-dd");
  const rows = [];
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues().forEach(function (r) {
      if (!r[2]) return;
      const time = r[1] instanceof Date ? Utilities.formatDate(r[1], TIME_ZONE, "yyyy-MM-dd HH:mm:ss") : String(r[1] || "").trim();
      if (time.slice(0, 10) < from) return;
      rows.push([Number(r[0]) || 0, time, String(r[2]), String(r[3] || ""), String(r[4] || "").trim().toLowerCase(),
        String(r[5] || "").trim()]);
    });
  }
  const students = {};
  rows.slice(-SUMMARY_RECENT).forEach(function (r) {
    if (r[5] && !(r[5] in students)) students[r[5]] = student_(r[5]);
  });
  return { ok: true, now: Utilities.formatDate(new Date(), TIME_ZONE, "yyyy-MM-dd HH:mm:ss"), from: from, days: days,
    rows: rows, students: students };
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

// { result: registered | blocked | expired | unregistered, studentId, ownerId }
// studentId is set only for an allowed (registered) vehicle and drives guardian messages;
// ownerId is the student on whichever row decided the result, so the page can show who it is.
function check_(license, province) {
  const plate = normPlate_(license);
  const prov = normText_(province);
  const today = Utilities.formatDate(new Date(), TIME_ZONE, "yyyy-MM-dd");
  let result = "unregistered";
  let studentId = "";
  let ownerId = "";
  vehicles_().forEach(function (v) {
    if (normPlate_(v.plate) !== plate) return;
    if (v.province && prov && normText_(v.province) !== prov) return;
    if (v.status === "blocked") { result = "blocked"; ownerId = v.studentId || ""; return; }
    if (v.status !== "active") return;
    if (v.validUntil && v.validUntil < today) {
      if (result === "unregistered") { result = "expired"; ownerId = v.studentId || ""; }
      return;
    }
    if (result !== "blocked") { result = "registered"; studentId = v.studentId || ""; ownerId = studentId; }
  });
  return { result: result, studentId: studentId, ownerId: ownerId };
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

// ---------- student details (Student + GroupCode sheets) ----------

// { id, found, name, group, room, groupName, advisor } for the page's history table, or null when
// the plate has no student. found = false when the id is not in the Student sheet.
function student_(id) {
  id = String(id || "").trim();
  if (!id || id === SECURITY_ID) return null;
  const cache = CacheService.getScriptCache();
  const hit = cache.get("s:" + id);
  if (hit) return JSON.parse(hit);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = null;
  STUDENT_SHEETS.some(function (n) { sheet = ss.getSheetByName(n); return Boolean(sheet); });
  let out = { id: id, found: false, name: "", group: "", room: "", groupName: "", advisor: "" };
  if (sheet && sheet.getLastRow() > 1) {
    const head = headers_(sheet);
    const idCol = head["student_id"];
    if (idCol) {
      const cell = sheet.getRange(2, idCol, sheet.getLastRow() - 1, 1).createTextFinder(id).matchEntireCell(true).findNext();
      if (cell) {
        const row = sheet.getRange(cell.getRow(), 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
        const col = function (name) { return head[name] ? String(row[head[name] - 1] || "").trim() : ""; };
        const code = col("groupcode");
        const g = groups_()[code] || {};
        out = {
          id: id, found: true,
          name: col("student_name"),
          group: code,
          room: [col("กลุ่มเรียน"), g.short].filter(String).join(" · "),
          groupName: g.name || "",
          advisor: g.advisor || "",
        };
      }
    }
  }
  cache.put("s:" + id, JSON.stringify(out), CACHE_SECONDS * 5);
  return out;
}

// รหัสกลุ่มเรียน -> { short, name, advisor }
function groups_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get("groups");
  if (hit) return JSON.parse(hit);
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GROUP_SHEET);
  const map = {};
  if (sheet && sheet.getLastRow() > 1) {
    const head = headers_(sheet);
    if (head["รหัสกลุ่มเรียน"]) {
      sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getDisplayValues().forEach(function (r) {
        const at = function (name) { return head[name] ? String(r[head[name] - 1] || "").trim() : ""; };
        const code = at("รหัสกลุ่มเรียน");
        if (code) map[code] = { short: at("ชื่อย่อกลุ่มเรียน"), name: at("ชื่อกลุ่มเรียน"), advisor: at("ครูที่ปรึกษา") };
      });
    }
  }
  cache.put("groups", JSON.stringify(map), CACHE_SECONDS * 5);
  return map;
}

// Header text (trimmed, lower case) -> 1-based column. The first matching header wins.
function headers_(sheet) {
  const head = {};
  sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].forEach(function (h, i) {
    const k = String(h || "").trim().toLowerCase();
    if (k && !head[k]) head[k] = i + 1;
  });
  return head;
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
