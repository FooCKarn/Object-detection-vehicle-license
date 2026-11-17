// Feeds the dashboard page (dashboard.html): LOG rows from the last N days, read through the
// Apps Script "summary" action. Nothing is written. The page does the counting.
//
// The rows carry plates and student names, so set DASHBOARD_KEY in Vercel to require a key:
// the page then asks for it once and sends it in the X-Dashboard-Key header.

const { callScript } = require("./_shared");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "method not allowed" });
  }
  res.setHeader("Cache-Control", "no-store");
  const key = process.env.DASHBOARD_KEY;
  if (key && String(req.headers["x-dashboard-key"] || "") !== key) {
    return res.status(401).json({ ok: false, error: "dashboard key required" });
  }
  if (!process.env.APPS_SCRIPT_URL || !process.env.APPS_SCRIPT_SECRET) {
    return res.status(503).json({ ok: false, error: "APPS_SCRIPT_URL / APPS_SCRIPT_SECRET is not set" });
  }
  const days = Math.max(1, Math.min(90, Math.floor(Number(req.query && req.query.days) || 30)));

  let data;
  try {
    data = await callScript({ action: "summary", days });
  } catch {
    return res.status(502).json({ ok: false, error: "could not reach Apps Script" });
  }
  if (!data.ok) {
    // A deployment without the summary action treats it as a log write and refuses (no license).
    const outdated = data.error === "license is required";
    return res.status(502).json({ ok: false, error: outdated ? "Apps Script needs a new deployment (summary action)" : data.error || "Apps Script error" });
  }
  return res.status(200).json(data);
};
