import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import fs from "fs";
const out = process.argv[2], V = +(process.argv[3] || 0); fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch(); const p = await b.newPage();
await p.goto("http://127.0.0.1:8081/gen.html"); await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(500);
const ids = await p.evaluate(() => CASES.map(c => [c.id, c.truth]));
const truth = {};
for (const [id, t] of ids) { const d = await p.evaluate(([id, V]) => make(id, V), [id, V]); fs.writeFileSync(`${out}/${id}.jpg`, Buffer.from(d.split(",")[1], "base64")); truth[id] = t; }
fs.writeFileSync(`${out}/truth.json`, JSON.stringify(truth, null, 1));
await b.close();
