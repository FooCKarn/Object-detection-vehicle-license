# PlateScan demo (static site)

Thai license plate detection and reading, fully in the browser.

- Detection: YOLOv9-t license plate model (open-image-models, MIT), `lib/lp640.onnx`, run with onnxruntime-web.
- Reading: Tesseract.js 5 with Thai traineddata, 8 reads per plate with per-character voting.

## Deploy to Vercel

From this folder:

    npx vercel deploy --prod

No build step; Vercel serves the folder as static files. To run locally: `npx serve .`

## Saving readings to Google Sheets and checking registration

Each plate read from an uploaded image (not the built-in samples) is sent to
`/api/log`, a Vercel function that forwards it to an Apps Script web app on the
LICENSE LOG sheet. The script checks the plate against the `REGISTER_VEHICLE` sheet and
appends `RECORD_ID | DATE_TIME | LICENSE | PROVINCE | RESULT`. RESULT is one of
`registered`, `blocked`, `expired`, `unregistered`, and the page shows it next to each reading.

Requests to Apps Script must carry a shared secret (script property `SECRET`); without
it the script rejects everything.

### `REGISTER_VEHICLE` sheet

Header in row 1: `plate_number | province | student_id | status | expired_date`

- `status`: `active` or `blocked` (anything else is not allowed)
- `province` empty = match any province
- `expired_date` empty = no expiry (date, `yyyy-mm-dd`)
- Spaces and dashes in the plate are ignored when matching

### One-time setup

1. Open the sheet, add a tab named `REGISTER_VEHICLE` with the header above, and name the log tab `LOG` with `RESULT` in cell E1.
2. Extensions > Apps Script, paste `apps-script/Code.gs`, save.
3. Project Settings > Script properties > add `SECRET` with a long random string.
4. Deploy > New deployment > type Web app. Execute as: Me. Who has access: Anyone. Authorize when asked. (After later code edits: Manage deployments > edit > New version.)
5. Copy the Web app URL (ends in `/exec`).
6. In Vercel: Project > Settings > Environment Variables, add `APPS_SCRIPT_URL` (that URL) and `APPS_SCRIPT_SECRET` (same string as `SECRET`), then redeploy.

The page shows "บันทึกลง Google Sheet" next to the history table once both variables are set.

Note: `/api/log` itself is still open to anyone who can reach the site, so keep student or parent
personal data out of this sheet's log and out of any public demo.

## LINE notifications to guardians

A guardian adds the college's LINE Official Account, sends the 6-character bind code staff gave them,
then replies `ยินยอม`. The webhook reads their LINE userId from the event and writes it to the sheet,
so nobody types a LINE ID. After that, every time a registered vehicle is read, the student's
consenting guardians get "นายสมชาย เข้าวิทยาลัย เวลา 07:42 น.", and blocked / expired / unregistered
plates alert the security guards. The same student or plate is not announced again within 10 minutes.

Bot commands: `<bind code>` (bind), `ยินยอม` (consent / resume), `ยกเลิก` (stop). A LINE user gets
locked out after 5 wrong codes in an hour.

### `STUDENT_GUARDIAN` sheet

Header in row 1: `student_id | student_name | bind_code | line_user_id | consent`

- Staff fill `student_id` (same value as in `REGISTER_VEHICLE`) and `student_name`; one row per guardian.
- Format the `bind_code` column as Plain text, then run `generateBindCodes` from the Apps Script editor to fill the empty codes. Give each guardian their own code.
- `line_user_id` and `consent` (`pending` / `yes` / `no`) are filled by the bot. Do not edit them by hand unless you are fixing a mistake.
- A row with `student_id` = `SECURITY` receives the alerts. Bind a guard's LINE account the same way (give that row a bind code, then the guard sends it and replies `ยินยอม`).

### One-time setup

1. Paste the new `apps-script/Code.gs`, Save, then Deploy > Manage deployments > edit > New version.
2. Create the `STUDENT_GUARDIAN` tab as above.
3. LINE Official Account Manager: create the account. LINE Developers: create a Messaging API channel for it.
4. In Vercel add `LINE_CHANNEL_SECRET` and `LINE_CHANNEL_ACCESS_TOKEN` (long-lived), then Redeploy.
5. LINE Developers > Messaging API: set Webhook URL to `https://<site>/api/line-webhook`, press Verify, and turn "Use webhook" on. In LINE Official Account Manager > Response settings, turn off auto-reply and greeting messages.
6. Open `https://<site>/api/line-webhook` in a browser: it should show `{"configured":true}`.

`/api/log` also accepts an optional `gate` (`in` or `out`) to say "เข้า" or "ออก" in the message;
without it the message says "ผ่านประตูวิทยาลัย".
