// Google Apps Script for the LICENSE LOG sheet.
// Log sheet columns:      ROCORD_ID | TIME | LICENSE | PROVINCE | RESULT   (header in row 1)
// "vehicles" sheet columns: plate_number | province | student_id | status | valid_until   (header in row 1)
//   status: active | blocked   (anything else counts as not allowed)
//   province may be left empty to match any province; valid_until may be left empty for no expiry.
//
// Deploy: Extensions > Apps Script, paste this file, then Project Settings > Script properties,
// add SECRET = <long random string>. Deploy > New deployment > Web app, Execute as: Me,
// Who has access: Anyone. Put the /exec URL in Vercel as APPS_SCRIPT_URL and the same secret as
// APPS_SCRIPT_SECRET. Requests without the right secret are rejected.

const SHEET_NAME = "ชีต1";
const VEHICLES_SHEET = "vehicles";
const TIME_ZONE = "Asia/Bangkok";
const CACHE_SECONDS = 60;

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    if (!authorized_(body.secret)) return json_({ ok: false, error: "unauthorized" });

    const license = clean_(body.license, 20);
    const province = clean_(body.province, 40);
    if (!license) return json_({ ok: false, error: "license is required" });

    const result = check_(license, province);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
    const id = Math.max(1, sheet.getLastRow()); // row 1 is the header, so the first record gets ID 1
    const time = Utilities.formatDate(new Date(), TIME_ZONE, "yyyy-MM-dd HH:mm:ss");
    sheet.appendRow([id, time, license, province, result]);
    return json_({ ok: true, id: id, time: time, result: result });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return json_({ ok: true, service: "license-log" });
}

// Fail closed: with no SECRET script property set, nothing is accepted.
function authorized_(given) {
  const secret = PropertiesService.getScriptProperties().getProperty("SECRET");
  return Boolean(secret) && String(given || "") === secret;
}

// registered | blocked | expired | unregistered
function check_(license, province) {
  const plate = normPlate_(license);
  const prov = normText_(province);
  const today = Utilities.formatDate(new Date(), TIME_ZONE, "yyyy-MM-dd");
  let result = "unregistered";
  vehicles_().forEach(function (v) {
    if (normPlate_(v.plate) !== plate) return;
    if (v.province && prov && normText_(v.province) !== prov) return;
    if (v.status === "blocked") { result = "blocked"; return; }
    if (v.status !== "active") return;
    if (v.validUntil && v.validUntil < today) { if (result === "unregistered") result = "expired"; return; }
    if (result !== "blocked") result = "registered";
  });
  return result;
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
        status: String(r[3] || "").trim().toLowerCase(),
        validUntil: r[4] instanceof Date ? Utilities.formatDate(r[4], TIME_ZONE, "yyyy-MM-dd") : String(r[4] || "").trim(),
      });
    });
  }
  cache.put("vehicles", JSON.stringify(rows), CACHE_SECONDS);
  return rows;
}

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
