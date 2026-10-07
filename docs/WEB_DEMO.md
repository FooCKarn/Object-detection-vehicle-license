# PlateScan demo (static site)

Thai license plate detection and reading, fully in the browser.

- Detection: YOLOv9-t license plate model (open-image-models, MIT), `lib/lp640.onnx`, run with onnxruntime-web.
- Reading: Tesseract.js 5 with Thai traineddata, 8 reads per plate with per-character voting.

## Deploy to Vercel

From this folder:

    npx vercel deploy --prod

No build step; Vercel serves the folder as static files. To run locally: `npx serve .`
