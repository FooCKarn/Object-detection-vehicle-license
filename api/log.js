// Forwards one plate reading from the demo page to the Google Apps Script web app
// bound to the LICENSE LOG sheet. The Apps Script URL stays server-side in the
// APPS_SCRIPT_URL environment variable (Vercel > Settings > Environment Variables).

const MAX_LICENSE = 20;
const MAX_PROVINCE = 40;

module.exports = async (req, res) => {
  const url = process.env.APPS_SCRIPT_URL;

  if (req.method === "GET") {
    return res.status(200).json({ configured: Boolean(url) });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "method not allowed" });
  }
  if (!url) {
    return res.status(503).json({ ok: false, error: "APPS_SCRIPT_URL is not set" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const license = String((body && body.license) || "").trim().slice(0, MAX_LICENSE);
  const province = String((body && body.province) || "").trim().slice(0, MAX_PROVINCE);
  if (!license) {
    return res.status(400).json({ ok: false, error: "license is required" });
  }

  try {
    // text/plain keeps Apps Script happy; it answers with a redirect that fetch follows.
    const upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ license, province }),
      redirect: "follow",
    });
    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { ok: false, error: "unexpected reply from Apps Script" }; }
    return res.status(upstream.ok && data.ok ? 200 : 502).json(data);
  } catch (err) {
    return res.status(502).json({ ok: false, error: "could not reach Apps Script" });
  }
};
