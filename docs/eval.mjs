import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import fs from "fs";
const [url, dir, only] = process.argv.slice(2);
const truth = JSON.parse(fs.readFileSync(dir + "/truth.json"));
const b = await chromium.launch(); const p = await b.newPage();
p.on("console", m => { if (m.type() === "error" || m.text().startsWith("[dbg]") && process.env.DBG) console.log("  console:", m.text().slice(0, 300)); });
await p.goto(url);
await p.waitForFunction(() => /YOLOv9|ตัวตรวจจับ/.test(document.getElementById("engineFlag").textContent), null, { timeout: 180000 });
await p.waitForFunction(() => document.getElementById("total").textContent.includes("s"), null, { timeout: 180000 });
let ok = 0, okNum = 0, okProv = 0, n = 0;
for (const id of Object.keys(truth)) {
  if (only && !id.match(only)) continue;
  n++;
  await p.evaluate(() => { document.getElementById("total").textContent = ""; });
  await p.setInputFiles("#file", `${dir}/${id}.jpg`);
  await p.waitForFunction(() => document.getElementById("total").textContent.includes("s"), null, { timeout: 600000 });
  const r = await p.evaluate(() => ({ t: document.getElementById("total").textContent,
    res: [...document.querySelectorAll("#readout .det")].map(d => [d.querySelector(".plate-text").textContent, d.querySelector(".prov").textContent, d.querySelector(".meta").textContent.replace(/\s+/g, " ")]) }));
  const [tn, tp] = truth[id].split("|"), norm = s => s.replace(/[\s-]/g, "");
  const best = r.res[0] || ["-", "-", ""];
  const gn = r.res.some(x => norm(x[0]) === norm(tn)), gp = r.res.some(x => x[1] === tp);
  ok += gn && gp; okNum += gn; okProv += gp;
  console.log(`${gn ? "✓" : "✗"}${gp ? "✓" : "✗"} ${id.padEnd(22)} want ${tn} ${tp} | got ${r.res.map(x => x[0] + " " + x[1] + " [" + x[2] + "]").join(" ; ") || "none"} | ${r.t}`);
}
console.log(`number ${okNum}/${n}  province ${okProv}/${n}  both ${ok}/${n}`);
await b.close();
