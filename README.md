
## v2 changes (motorcycle, decorative plates, shadow and dirt)

- Detection: YOLOv9-s (`lib/lp608s.onnx`, 28 MB) runs next to the YOLOv9-t model; boxes are fused, a zoomed second pass tightens loose boxes, and large photos are re-scanned in overlapping tiles when nothing is confident.
- Motorcycle plates (3 rows: letters / province / number): chosen by box shape (and tried as a fallback), rows found from an ink profile, each row read on its own.
- OCR preprocessing: local-background normalisation (cancels shadows and mud wash), speck removal, extra read variants voted with the old ones.
- Test harness: `docs/eval.mjs` (Playwright) and `docs/testset-gen/` (synthetic motorcycle, auction, shadow and dirt plates). Synthetic only, so it measures regressions, not real-world accuracy.
