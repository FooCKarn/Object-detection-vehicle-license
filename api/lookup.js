// Checks one plate reading against the REGISTER_VEHICLE sheet without writing to the log, so the
// page can colour every reading (sample images and readings with sheet logging switched off too).
// The reply carries the same result as /api/log: registered | blocked | expired | unregistered.

const { callScript } = require("./_shared");

const MAX_LICENSE = 20;
const MAX_PROVINCE = 40;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method not allowed" });
  }
  if (!process.env.APPS_SCRIPT_URL || !process.env.APPS_SCRIPT_SECRET) {
    return res.status(503).json({ ok: false, error: "APPS_SCRIPT_URL / APPS_SCRIPT_SECRET is not set" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const license = String((body && body.license) || "").trim().slice(0, MAX_LICENSE);
  const province = String((body && body.province) || "").trim().slice(0, MAX_PROVINCE);
  if (!license) return res.status(400).json({ ok: false, error: "license is required" });

  // The plate goes in `plate`, not `license`: an Apps Script deployment that predates the lookup
  // action treats unknown actions as a log write, and without `license` it refuses instead of logging.
  let data;
  try {
    data = await callScript({ action: "lookup", plate: license, province });
  } catch {
    return res.status(502).json({ ok: false, error: "could not reach Apps Script" });
  }
  if (!data.ok) {
    const outdated = data.error === "license is required";
    return res.status(502).json({ ok: false, error: outdated ? "Apps Script needs a new deployment (lookup action)" : data.error || "Apps Script error" });
  }
  return res.status(200).json({ ok: true, result: data.result });
};
