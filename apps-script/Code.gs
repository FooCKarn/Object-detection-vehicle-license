// Google Apps Script for the LICENSE LOG sheet.
// Columns: ROCORD_ID | TIME | LICENSE | PROVINCE (header in row 1).
// Deploy: Extensions > Apps Script, paste this file, Deploy > New deployment >
// Web app, Execute as: Me, Who has access: Anyone. Put the /exec URL in Vercel
// as APPS_SCRIPT_URL.

const SHEET_NAME = "ชีต1";
const TIME_ZONE = "Asia/Bangkok";

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const license = clean_(body.license, 20);
    const province = clean_(body.province, 40);
    if (!license) return json_({ ok: false, error: "license is required" });

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
    const id = Math.max(1, sheet.getLastRow()); // row 1 is the header, so the first record gets ID 1
    const time = Utilities.formatDate(new Date(), TIME_ZONE, "yyyy-MM-dd HH:mm:ss");
    sheet.appendRow([id, time, license, province]);
    return json_({ ok: true, id: id, time: time });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return json_({ ok: true, service: "license-log" });
}

// Trim, cap length, and stop text that starts with = + - @ from being read as a formula.
function clean_(value, max) {
  let s = String(value || "").trim().slice(0, max);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
