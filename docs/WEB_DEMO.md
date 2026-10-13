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
