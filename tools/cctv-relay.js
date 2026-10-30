#!/usr/bin/env node
// PlateScan CCTV relay: run this on a computer in the same network as the cameras.
//
// The Vercel site is HTTPS, so a browser will not load a camera's http:// or rtsp:// link from it, and
// Vercel itself cannot reach cameras inside the local network. This relay closes that gap without
// installing anything but Node.js (and ffmpeg, only for rtsp:// cameras):
//
//   node tools/cctv-relay.js            then open http://localhost:8080 on this computer
//
// - serves the PlateScan page from this folder, so the page, the camera and the readings share one origin
// - /cam?src=<camera link>  fetches the camera (http/https with basic or digest login in the link,
//   or rtsp through ffmpeg) and passes it on as MJPEG; a snapshot link (one JPEG per request) is fetched
//   over and over and turned into a stream
// - /api/*  is forwarded to the real site (--site), so readings still go to the Google Sheet and LINE
//
// Options: --port 8080   --lan (let phones and other computers in the network open the page)
//          --site https://object-detection-vehicle-license.vercel.app   --any-host (allow non-local cameras)
// Docs: docs/CCTV.md

"use strict";
const http = require("http"), https = require("https"), fs = require("fs"), path = require("path");
const crypto = require("crypto"), dns = require("dns").promises, net = require("net"), { spawn, spawnSync } = require("child_process");

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf("--" + name); return i < 0 ? def : args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true; };
const PORT = Number(opt("port", 8080));
const LAN = opt("lan", false) === true;
const SITE = String(opt("site", "https://object-detection-vehicle-license.vercel.app")).replace(/\/+$/, "");
const ANY_HOST = opt("any-host", false) === true;
const ROOT = path.resolve(__dirname, "..");
const HAS_FFMPEG = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const BOUNDARY = "platescanframe";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm",
  ".json": "application/json", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

// ---------- camera access: only cameras in this network unless --any-host ----------
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:") && privateIp(v.slice(7));
}
async function allowedHost(hostname) {
  if (ANY_HOST) return true;
  const h = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(h)) return privateIp(h);
  try { return (await dns.lookup(h, { all: true })).every(a => privateIp(a.address)); } catch { return false; }
}

// ---------- http(s) camera request with basic / digest login taken from the link ----------
function digestHeader(www, user, pass, method, uri) {
  const p = {}; www.replace(/(\w+)=("([^"]*)"|[^,\s]+)/g, (_, k, _v, q) => { p[k.toLowerCase()] = q ?? _v; });
  const algo = (p.algorithm || "MD5").toUpperCase(), md5 = s => crypto.createHash(algo.startsWith("SHA-256") ? "sha256" : "md5").update(s).digest("hex");
  const qop = (p.qop || "").split(",").map(s => s.trim()).includes("auth") ? "auth" : "";
  const nc = "00000001", cnonce = crypto.randomBytes(8).toString("hex");
  let ha1 = md5(`${user}:${p.realm}:${pass}`);
  if (algo.endsWith("-SESS")) ha1 = md5(`${ha1}:${p.nonce}:${cnonce}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop ? md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`);
  return `Digest username="${user}", realm="${p.realm}", nonce="${p.nonce}", uri="${uri}", response="${response}"` +
    (p.algorithm ? `, algorithm=${p.algorithm}` : "") + (p.opaque ? `, opaque="${p.opaque}"` : "") + (qop ? `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"` : "");
}
function request(u, headers = {}) {
  return new Promise((ok, fail) => {
    const req = (u.protocol === "https:" ? https : http).get(u, { headers, rejectUnauthorized: false, timeout: 10000 }, ok);
    req.on("timeout", () => req.destroy(new Error("camera did not answer"))); req.on("error", fail);
  });
}
async function openCamera(link) {
  const u = new URL(link), user = decodeURIComponent(u.username), pass = decodeURIComponent(u.password);
  u.username = ""; u.password = "";
  const basic = user ? { Authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") } : {};
  let res = await request(u, basic);
  if (res.statusCode === 401 && user && /^digest/i.test(res.headers["www-authenticate"] || "")) {
    res.resume();
    res = await request(u, { Authorization: digestHeader(res.headers["www-authenticate"], user, pass, "GET", u.pathname + u.search) });
  }
  return res;
}
const readAll = res => new Promise((ok, fail) => { const parts = []; res.on("data", d => parts.push(d)); res.on("end", () => ok(Buffer.concat(parts))); res.on("error", fail); });

// ---------- /cam ----------
async function serveCamera(req, res, link) {
  let u;
  try { u = new URL(link); } catch { return fail(res, 400, "ลิงก์กล้องไม่ถูกต้อง"); }
  if (!/^(https?|rtsps?):$/.test(u.protocol)) return fail(res, 400, "รองรับ http://, https:// และ rtsp://");
  if (!(await allowedHost(u.hostname))) return fail(res, 403, "ตัวกลางเปิดได้เฉพาะกล้องในวงแลน (เริ่มด้วย --any-host เพื่อเปิดกล้องนอกวง)");
  if (u.protocol.startsWith("rtsp")) return rtspToMjpeg(req, res, link);
  let cam;
  try { cam = await openCamera(link); } catch (e) { return fail(res, 502, "ต่อกล้องไม่ได้: " + e.message); }
  if (cam.statusCode === 401) { cam.resume(); return fail(res, 401, "กล้องปฏิเสธการเข้าสู่ระบบ ใส่ชื่อผู้ใช้และรหัสในลิงก์ เช่น http://admin:รหัส@192.168.1.64/..."); }
  if (cam.statusCode >= 400) { cam.resume(); return fail(res, 502, "กล้องตอบ HTTP " + cam.statusCode); }
  const type = cam.headers["content-type"] || "";
  if (/^image\//i.test(type)) return snapshotStream(req, res, link, await readAll(cam), type);
  // a stream (MJPEG, mp4, HLS playlist...) goes through as it is
  res.writeHead(200, { "Content-Type": type || "application/octet-stream", "Cache-Control": "no-store" });
  cam.pipe(res);
  req.on("close", () => cam.destroy());
}
// a snapshot link answers one picture per request: keep asking and send the pictures as MJPEG
async function snapshotStream(req, res, link, first, type) {
  let open = true; req.on("close", () => { open = false; });
  res.writeHead(200, { "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`, "Cache-Control": "no-store" });
  let frame = first;
  while (open) {
    res.write(`--${BOUNDARY}\r\nContent-Type: ${type}\r\nContent-Length: ${frame.length}\r\n\r\n`); res.write(frame); res.write("\r\n");
    const t = Date.now();
    try { const cam = await openCamera(link); if (cam.statusCode === 200) frame = await readAll(cam); else cam.resume(); } catch { /* keep the last picture */ }
    await new Promise(r => setTimeout(r, Math.max(0, 250 - (Date.now() - t))));
  }
  res.end();
}
function rtspToMjpeg(req, res, link) {
  if (!HAS_FFMPEG) return fail(res, 501, "เปิด rtsp:// ต้องติดตั้ง ffmpeg บนคอมที่รันตัวกลางก่อน (ดู docs/CCTV.md)");
  const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp", "-i", link,
    "-an", "-vf", "scale='min(1920,iw)':-2", "-r", "8", "-q:v", "4", "-f", "mpjpeg", "-boundary_tag", BOUNDARY, "pipe:1"]);
  let started = false, err = "";
  ff.stderr.on("data", d => { err += d; });
  ff.stdout.once("data", () => { started = true; });
  ff.stdout.on("data", d => {
    if (!res.headersSent) res.writeHead(200, { "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`, "Cache-Control": "no-store" });
    res.write(d);
  });
  ff.on("close", () => { if (!started) fail(res, 502, "เปิดสตรีม rtsp ไม่ได้: " + (err.trim().split("\n").pop() || "ffmpeg หยุดทำงาน")); else res.end(); });
  req.on("close", () => ff.kill("SIGKILL"));
}

// ---------- /api/* → the real site ----------
async function forwardApi(req, res) {
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readAll(req);
  try {
    const r = await fetch(SITE + req.url, { method: req.method, body, headers: { "Content-Type": req.headers["content-type"] || "application/json" } });
    res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") || "application/json" });
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) { fail(res, 502, "ต่อเว็บ " + SITE + " ไม่ได้: " + e.message); }
}

// ---------- static files ----------
function serveFile(req, res) {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT + path.sep) || /[\\/]\./.test(path.relative(ROOT, file)) || /^[\\/]?(tools|api|apps-script)[\\/]/.test(path.relative(ROOT, file)))
    return fail(res, 404, "not found");
  fs.stat(file, (e, st) => {
    if (e || !st.isFile()) return fail(res, 404, "not found");
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Content-Length": st.size });
    fs.createReadStream(file).pipe(res);
  });
}

function fail(res, code, msg) {
  if (res.headersSent) return res.end();
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" }); res.end(msg);
}

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/relay/info") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: true, ffmpeg: HAS_FFMPEG, site: SITE })); }
  if (u.pathname === "/cam") return serveCamera(req, res, u.searchParams.get("src") || "").catch(e => fail(res, 500, e.message));
  if (u.pathname.startsWith("/api/")) return forwardApi(req, res);
  if (req.method !== "GET" && req.method !== "HEAD") return fail(res, 405, "method not allowed");
  serveFile(req, res);
}).listen(PORT, LAN ? "0.0.0.0" : "127.0.0.1", () => {
  console.log(`PlateScan CCTV relay: open http://localhost:${PORT}` + (LAN ? " (or http://<this computer's IP>:" + PORT + " from other devices)" : ""));
  console.log(`readings go to ${SITE}` + (HAS_FFMPEG ? "" : "  ·  ffmpeg not found: rtsp:// links will not open"));
});
