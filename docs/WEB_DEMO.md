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

Every reading is also coloured by that result: green "พบในฐานข้อมูล" for `registered`, red for
`unregistered` ("ไม่พบในฐานข้อมูล") and for `blocked` / `expired` (found but not allowed), and grey
while checking or when the check fails. Readings that are not logged (samples, or logging switched
off) get their result from `/api/lookup`, which runs the same check through the script's `lookup`
action without writing a row or sending LINE messages. After updating `Code.gs`, deploy a new
version of the web app (step 4 below) or the lookup answers "Apps Script needs a new deployment".

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

The OA's rich menu has two buttons, "ลงทะเบียน" and "ยกเลิกการแจ้งเตือน". Both open the LIFF page
(`liff/index.html`). To register, a guardian types the 6-character bind code staff gave them and ticks
the consent box; one tap binds their LINE account and turns notifications on. The cancel page lists the
students they follow and stops all of them. `/api/liff` checks the LIFF ID token with LINE and takes the
userId from it, so nobody types a LINE ID and a page cannot act for someone else's account. A short
confirmation message is pushed to the chat after each change.

After that, every time a registered vehicle is read, the student's consenting guardians get
"นายสมชาย เข้าวิทยาลัย เวลา 07:42 น.", and blocked / expired / unregistered plates alert the security
guards. The same student or plate is not announced again within 10 minutes.

The chat itself only carries notifications: a new follower gets one welcome message and any other text
gets "กรุณาใช้เมนูด้านล่าง". The old typed commands (`<bind code>`, `ยินยอม`, `ยกเลิก`) still work for
guardians who started that way; set `LEGACY_CHAT_COMMANDS=off` in Vercel to drop them. A LINE user gets
locked out after 5 wrong codes in an hour, on the page and in the chat alike.

### `STUDENT_GUARDIAN` sheet

Header in row 1: `student_id | student_name | bind_code | line_user_id | consent`

- Staff fill `student_id` (same value as in `REGISTER_VEHICLE`) and `student_name`; one row per guardian.
- Format the `bind_code` column as Plain text, then run `generateBindCodes` from the Apps Script editor to fill the empty codes. Give each guardian their own code.
- `line_user_id` and `consent` (`pending` / `yes` / `no`) are filled by the system. Do not edit them by hand unless you are fixing a mistake.
- A row with `student_id` = `SECURITY` receives the alerts. A guard registers on the same page with that row's bind code.

### One-time setup

1. Paste the new `apps-script/Code.gs`, Save, then Deploy > Manage deployments > edit > New version (keeps the same URL).
2. Create the `STUDENT_GUARDIAN` tab as above.
3. LINE Official Account Manager: create the account. LINE Developers: create a Messaging API channel for it.
4. In Vercel add `LINE_CHANNEL_SECRET` and `LINE_CHANNEL_ACCESS_TOKEN` (long-lived), then Redeploy.
5. LINE Developers > Messaging API: set Webhook URL to `https://<site>/api/line-webhook`, press Verify, and turn "Use webhook" on. In LINE Official Account Manager > Response settings, turn off auto-reply and greeting messages (the webhook sends the welcome).
6. Open `https://<site>/api/line-webhook` in a browser: it should show `{"configured":true}`.

### LIFF registration page

1. LINE Developers: in the **same provider** as the Messaging API channel, create a **LINE Login** channel. (LINE userIds differ between providers; in another provider the page would save ids the OA cannot message.) Under Basic settings, set "Linked LINE Official Account" to the OA. Publish the channel (Developing > Published) so guardians can use it.
2. In that channel, LIFF > Add: Size `Tall`, Endpoint URL `https://<site>/liff/`, Scopes `openid`, Add friend option `On (Aggressive)`. Copy the LIFF ID.
3. In Vercel add `LIFF_ID` (the LIFF ID) and `LINE_LOGIN_CHANNEL_ID` (the LINE Login channel's Channel ID, under Basic settings), then Redeploy. `https://<site>/api/liff` should show `"configured":true`.
4. LINE Official Account Manager > Rich menus > Create: template with 2 areas (2500x843), set "Menu bar" text to "เมนู" and Default display on. Left area: Link `https://liff.line.me/<LIFF_ID>?mode=register`, label "ลงทะเบียน". Right area: Link `https://liff.line.me/<LIFF_ID>?mode=cancel`, label "ยกเลิกการแจ้งเตือน".
5. Test with one test row: register from the menu, check that `line_user_id` and `consent` = `yes` appear in the sheet, log a plate for that student and get the message, then cancel.

`/api/log` also accepts an optional `gate` (`in` or `out`) to say "เข้า" or "ออก" in the message;
without it the message says "ผ่านประตูวิทยาลัย".
