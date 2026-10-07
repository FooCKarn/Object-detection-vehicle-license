# PlateScan demo (static site)

Thai license plate detection and reading, fully in the browser.

- Detection: YOLOv9-t license plate model (open-image-models, MIT), `lib/lp640.onnx`, run with onnxruntime-web.
- Reading: Tesseract.js 5 with Thai traineddata, 8 reads per plate with per-character voting.

## Deploy to Vercel

From this folder:

    npx vercel deploy --prod

No build step; Vercel serves the folder as static files. To run locally: `npx serve .`

## Saving readings to Google Sheets

Each plate read from an uploaded image (not the built-in samples) is sent to
`/api/log`, a Vercel function that forwards it to an Apps Script web app on the
LICENSE LOG sheet. The script appends `ROCORD_ID | TIME | LICENSE | PROVINCE`.

One-time setup:

1. Open the sheet, Extensions > Apps Script, paste `apps-script/Code.gs`, save.
2. Deploy > New deployment > type Web app. Execute as: Me. Who has access: Anyone. Authorize when asked.
3. Copy the Web app URL (ends in `/exec`).
4. In Vercel: Project > Settings > Environment Variables, add `APPS_SCRIPT_URL` with that URL, then redeploy.

The page shows "บันทึกลง Google Sheet" next to the history table once `APPS_SCRIPT_URL` is set.
