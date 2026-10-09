// ---------------------------------------------------------------------------
// server.js
// ---------------------------------------------------------------------------
// Express server the React Native app calls. It works with MANY app targets at
// once — each target is one app + its developer-account credentials (see
// targets.js / apps.json). The frontend picks a target and sends its id in the
// "x-target-id" header; every endpoint resolves that target for auth + proxy.
//
// Key endpoints:
//   GET   /targets            -> list of app targets to choose from
//   GET   /app                -> selected app's name / bundle id
//   GET   /status             -> latest version's review state
//   GET   /locales            -> added + addable locales (editable version)
//   POST  /locales/add        -> add locales
//   GET   /metadata           -> current fields (primary locale) to prefill
//   PATCH /metadata           -> translate + push fields to every locale
//   GET   /screenshots        -> local screenshot files + locales
//   POST  /screenshots/push   -> upload screenshots to selected locales
//   GET   /telegram/test      -> send the status digest to Telegram now
// ---------------------------------------------------------------------------

require("dotenv").config();

const path = require("path");
const express = require("express");
const appstore = require("./appstore");
const translate = require("./translate");
const screenshotsLib = require("./screenshots");
const telegram = require("./telegram");
const proxy = require("./proxy");
const targets = require("./targets");
const statusStore = require("./statusStore");
const gameCenter = require("./gameCenter");
const { discoverAll } = require("./discover");

// Prefix every console line with a local timestamp, e.g.
//   [2026-07-30 14:23:05] [monitor] no changes — nothing sent.
// so monitor (and all other) logs are easy to correlate in time.
(() => {
  const stamp = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `[${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}]`;
  };
  for (const level of ["log", "warn", "error"]) {
    const orig = console[level].bind(console);
    console[level] = (...args) => orig(stamp(), ...args);
  }
})();

// Turn "WAITING_FOR_REVIEW" into "Waiting For Review".
function prettyState(s) {
  return (s || "UNKNOWN")
    .split("_")
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(" ");
}

// Telegram messages can't color text, so we prefix each status with a colored
// dot emoji that stands in for the requested color:
//   🔴 rejected   🟢 ready for distribution   🟡 waiting for review
//   🟣 developer release   🩷 in review   ⚪ everything else
function statusEmoji(state) {
  switch (state) {
    case "REJECTED":
    case "DEVELOPER_REJECTED":
    case "METADATA_REJECTED":
    case "INVALID_BINARY":
      return "🔴";
    case "READY_FOR_DISTRIBUTION":
    case "READY_FOR_SALE":
      return "🟢";
    case "WAITING_FOR_REVIEW":
    case "WAITING_FOR_EXPORT_COMPLIANCE":
      return "🟡";
    case "PENDING_DEVELOPER_RELEASE":
    case "PENDING_APPLE_RELEASE":
      return "🟣";
    case "IN_REVIEW":
      return "🩷";
    default:
      return "⚪";
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-07-08T10:49:35Z" -> "8 Jul 2026".
function formatDate(iso) {
  if (!iso) return "unknown";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "unknown";
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// "3 days ago" / "1 day ago" / "today" — how long it's been in this status.
function daysAgo(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return "today";
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

// How often to poll GREY apps (hands-off; liveness only). Default 24h.
const STABLE_INTERVAL_HOURS = Number(process.env.STABLE_INTERVAL_HOURS) || 24;
const DAILY_MS = STABLE_INTERVAL_HOURS * 60 * 60 * 1000;

// A grey app is due for its once-per-STABLE_INTERVAL_HOURS liveness check.
function greyDue(record, nowMs) {
  if (!record || !record.lastPolledAt) return true; // never polled -> poll now
  return nowMs - Date.parse(record.lastPolledAt) >= DAILY_MS;
}

const app = express();
app.use(express.json());

// Tiny request logger.
app.use((req, _res, next) => {
  console.log(`[http] ${req.method} ${req.path}`);
  next();
});

// ---------------------------------------------------------------------------
// Target resolution + error handling
// ---------------------------------------------------------------------------

// Resolve the target from the x-target-id header (default "0"). On failure it
// sends a 400 and returns null.
function getTarget(req, res) {
  const id = req.header("x-target-id") || "0";
  try {
    return targets.get(id);
  } catch (e) {
    res.status(400).json({ ok: false, status: 400, message: e.message });
    return null;
  }
}

function describeAppleStatus(status) {
  switch (status) {
    case 401:
      return "Unauthorized — the API key/JWT is invalid for this account.";
    case 403:
      return "Forbidden — the API key lacks permission for this resource.";
    case 404:
      return "Not Found — the resource doesn't exist for this app.";
    case 409:
      return "Conflict — the version state does not allow this edit (e.g. not editable).";
    case 422:
      return "Unprocessable Entity — the value was rejected (too long / invalid).";
    default:
      return "App Store Connect API error.";
  }
}

// Translate an error into a clean response. `proxyUrl` (the target's) lets us
// point at the proxy when it fails to reach Apple.
function handleError(err, res, proxyUrl) {
  if (err.response) {
    const status = err.response.status;
    const appleErrors = (err.response.data && err.response.data.errors) || [];
    let friendly = describeAppleStatus(status);

    const proxyTarget = proxy.describe(proxyUrl);
    if (
      proxyTarget &&
      appleErrors.length === 0 &&
      [502, 504, 407].includes(status)
    ) {
      friendly =
        `Proxy error ${status} — the proxy (${proxyTarget}) could not reach ` +
        `App Store Connect. Try another proxy exit/country, or clear the proxy.`;
    }

    console.error(`[error] ${status}: ${friendly}`);
    appleErrors.forEach((e, i) =>
      console.error(
        `  [error ${i + 1}] ${e.title || ""} — ${e.detail || ""} (code: ${e.code || "n/a"})`,
      ),
    );

    return res
      .status(status)
      .json({ ok: false, status, message: friendly, appleErrors });
  }

  if (err.request) {
    console.error(`[error] Network error reaching Apple: ${err.message}`);
    return res.status(502).json({
      ok: false,
      status: 502,
      message: "Network error — could not reach App Store Connect API.",
      detail: err.message,
    });
  }

  console.error(`[error] Local error: ${err.message}`);
  return res
    .status(500)
    .json({
      ok: false,
      status: 500,
      message: err.message || "Internal server error.",
    });
}

// Per-locale error helper for multi-step endpoints.
function markLocaleFail(entry, err, stage) {
  entry.ok = false;
  entry.stage = stage;
  if (err && err.response) {
    entry.status = err.response.status;
    entry.message = describeAppleStatus(err.response.status);
    entry.appleErrors = (err.response.data && err.response.data.errors) || [];
  } else if (err && err.request) {
    entry.status = 502;
    entry.message = "Network error reaching App Store Connect API.";
  } else {
    entry.status = 500;
    entry.message = (err && err.message) || "Unknown error.";
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({ ok: true, message: "Backend is running." });
});

// GET /targets — the list of apps you can work with (no secrets).
app.get("/targets", (_req, res) => {
  res.json({ ok: true, targets: targets.list() });
});

// GET /app — the selected app's name / bundle id.
app.get("/app", async (req, res) => {
  const target = getTarget(req, res);
  if (!target) return;
  try {
    const app_ = await appstore.getApp(target);
    res.json({ ok: true, app: app_ });
  } catch (err) {
    handleError(err, res, target.proxyUrl);
  }
});

// GET /status — the latest version's review state (no Telegram send).
app.get("/status", async (req, res) => {
  const target = getTarget(req, res);
  if (!target) return;
  try {
    const [app_, v, sale] = await Promise.all([
      appstore.getApp(target),
      appstore.getLatestVersion(target),
      appstore.getSaleStatus(target),
    ]);
    // Read-only: the monitor is the sole writer of the "since" store.
    const since = v ? statusStore.peekSince(target.id) || v.createdDate : null;
    res.json({
      ok: true,
      app: { name: app_.name },
      version: v
        ? {
            versionString: v.versionString,
            state: v.state,
            pretty: prettyState(v.state),
            since,
          }
        : null,
      // forSale === false means the app was pulled from the store even though
      // the version state may still read Waiting for Review / Ready for Sale.
      forSale: sale ? sale.forSale : null,
      removed: sale ? sale.forSale === false : false,
      telegram: telegram.status(),
    });
  } catch (err) {
    handleError(err, res, target.proxyUrl);
  }
});

// ---------------------------------------------------------------------------
// Locales
// ---------------------------------------------------------------------------

// GET /locales — added + still-addable locales for the editable version.
app.get("/locales", async (req, res) => {
  const target = getTarget(req, res);
  if (!target) return;
  try {
    const version = await appstore.getEditableVersion(target);
    if (!version) {
      return res.status(409).json({
        ok: false,
        status: 409,
        message:
          "No editable version (Waiting for Review / Prepare for Submission). " +
          "Create or submit a new version in App Store Connect first.",
      });
    }
    const locs = await appstore.getVersionLocalizationsById(target, version.id);
    const existing = new Set(locs.map((l) => l.locale));
    const addable = appstore.APP_STORE_LOCALES.filter((l) => !existing.has(l));

    let primaryLocale = null;
    try {
      primaryLocale = (await appstore.getApp(target)).primaryLocale || null;
    } catch (e) {
      /* best-effort */
    }

    res.json({
      ok: true,
      version,
      primaryLocale,
      added: locs.map((l) => l.locale),
      addable,
    });
  } catch (err) {
    handleError(err, res, target.proxyUrl);
  }
});

// POST /locales/add — add localizations. Body: { "locales": ["de-DE", ...] }
app.post("/locales/add", async (req, res) => {
  const target = getTarget(req, res);
  if (!target) return;
  const { locales } = req.body || {};
  if (!Array.isArray(locales) || locales.length === 0) {
    return res
      .status(400)
      .json({
        ok: false,
        status: 400,
        message: 'Provide a non-empty "locales" array.',
      });
  }

  try {
    const version = await appstore.getEditableVersion(target);
    if (!version) {
      return res
        .status(409)
        .json({
          ok: false,
          status: 409,
          message: "No editable version to add locales to.",
        });
    }
    const existing = new Set(
      (await appstore.getVersionLocalizationsById(target, version.id)).map(
        (l) => l.locale,
      ),
    );

    const results = [];
    for (const locale of locales) {
      const entry = { locale, ok: false };
      if (existing.has(locale)) {
        entry.ok = true;
        entry.status = 200;
        entry.message = "Already added.";
        results.push(entry);
        continue;
      }
      try {
        await appstore.createVersionLocalization(target, version.id, locale);
        entry.ok = true;
        entry.status = 201;
        console.log(`[ok] added locale ${locale}`);
      } catch (err) {
        markLocaleFail(entry, err, "create");
        console.error(`[error] add locale ${locale}: ${entry.message}`);
      }
      results.push(entry);
    }

    const allOk = results.every((r) => r.ok);
    res
      .status(allOk ? 200 : 207)
      .json({ ok: allOk, status: allOk ? 200 : 207, version, results });
  } catch (err) {
    handleError(err, res, target.proxyUrl);
  }
});

// ---------------------------------------------------------------------------
// Metadata (Promotional Text, Description, Keywords, What's New, Support URL,
// Privacy Policy URL). Text fields are TRANSLATED per locale; URL fields are
// pushed AS-IS. supportUrl -> version localization; privacyPolicyUrl -> App Info.
// ---------------------------------------------------------------------------
const TRANSLATABLE_FIELDS = [
  "promotionalText",
  "description",
  "keywords",
  "whatsNew",
];
const VERSION_URL_FIELDS = ["supportUrl"];
const APPINFO_URL_FIELDS = ["privacyPolicyUrl"];
const URL_FIELDS = [...VERSION_URL_FIELDS, ...APPINFO_URL_FIELDS];
const METADATA_FIELDS = [...TRANSLATABLE_FIELDS, ...URL_FIELDS];

// GET /metadata — current field values FROM THE PRIMARY LOCALE (prefill).
app.get("/metadata", async (req, res) => {
  const target = getTarget(req, res);
  if (!target) return;
  try {
    const version = await appstore.getEditableVersion(target);
    if (!version) {
      return res.status(409).json({
        ok: false,
        status: 409,
        message:
          "No editable version found. Description / Keywords / What's New can " +
          "only be edited on a version in an editable state (e.g. Waiting for " +
          "Review or Prepare for Submission). Create or submit a new version first.",
      });
    }

    let primaryLocale = null;
    try {
      primaryLocale = (await appstore.getApp(target)).primaryLocale || null;
    } catch (e) {
      /* best-effort */
    }

    const locs = await appstore.getVersionLocalizationsById(target, version.id);
    const base =
      locs.find((l) => l.locale === primaryLocale) ||
      locs.find((l) => l.locale === "en-US") ||
      locs[0];
    const a = (base && base.attributes) || {};

    let privacyPolicyUrl = "";
    try {
      const appInfo = await appstore.getEditableAppInfo(target);
      if (appInfo) {
        const alocs = await appstore.getAppInfoLocalizations(
          target,
          appInfo.id,
        );
        const abase =
          alocs.find((l) => l.locale === (base && base.locale)) ||
          alocs.find((l) => l.locale === "en-US") ||
          alocs[0];
        privacyPolicyUrl = (abase && abase.attributes.privacyPolicyUrl) || "";
      }
    } catch (e) {
      /* best-effort */
    }

    res.json({
      ok: true,
      version,
      primaryLocale,
      baseLocale: base ? base.locale : null,
      locales: locs.map((l) => l.locale),
      fields: {
        promotionalText: a.promotionalText || "",
        description: a.description || "",
        keywords: a.keywords || "",
        whatsNew: a.whatsNew || "",
        supportUrl: a.supportUrl || "",
        privacyPolicyUrl,
      },
    });
  } catch (err) {
    handleError(err, res, target.proxyUrl);
  }
});

// PATCH /metadata — per-field { value, push, translate } (a plain string means
// push + translate). Translates text fields; pushes URLs as-is.
app.patch("/metadata", async (req, res) => {
  const target = getTarget(req, res);
  if (!target) return;
  const body = req.body || {};

  function parseField(raw) {
    if (raw == null) return null;
    if (typeof raw === "string")
      return { value: raw, push: true, translate: true };
    if (typeof raw === "object") {
      return {
        value: typeof raw.value === "string" ? raw.value : "",
        push: !!raw.push,
        translate: raw.translate !== false,
      };
    }
    return null;
  }

  const incoming = {};
  for (const f of METADATA_FIELDS) {
    const p = parseField(body[f]);
    if (p && p.push && p.value.trim().length > 0) incoming[f] = p;
  }
  if (Object.keys(incoming).length === 0) {
    return res.status(400).json({
      ok: false,
      status: 400,
      message:
        "Nothing to push — provide at least one field with push=true and a non-empty value.",
    });
  }

  for (const f of Object.keys(incoming)) {
    const max = translate.FIELD_LIMITS[f];
    if (max && incoming[f].value.length > max) {
      return res
        .status(400)
        .json({
          ok: false,
          status: 400,
          message: `"${f}" must be ${max} characters or fewer.`,
        });
    }
  }
  for (const f of URL_FIELDS) {
    if (incoming[f] && !/^https?:\/\/.+/i.test(incoming[f].value.trim())) {
      return res
        .status(400)
        .json({
          ok: false,
          status: 400,
          message: `${f} must be a valid http(s) URL.`,
        });
    }
  }

  const translatableSource = {};
  const versionPassthrough = {};
  const appInfoPassthrough = {};
  for (const f of TRANSLATABLE_FIELDS) {
    if (!incoming[f]) continue;
    if (incoming[f].translate) translatableSource[f] = incoming[f].value;
    else versionPassthrough[f] = incoming[f].value.trim();
  }
  for (const f of VERSION_URL_FIELDS) {
    if (incoming[f]) versionPassthrough[f] = incoming[f].value.trim();
  }
  for (const f of APPINFO_URL_FIELDS) {
    if (incoming[f]) appInfoPassthrough[f] = incoming[f].value.trim();
  }

  const hasVersionWork =
    Object.keys(translatableSource).length > 0 ||
    Object.keys(versionPassthrough).length > 0;
  const hasAppInfoWork = Object.keys(appInfoPassthrough).length > 0;

  const byLocale = new Map();
  const entryFor = (locale) => {
    if (!byLocale.has(locale))
      byLocale.set(locale, { locale, ok: true, status: 200, translated: {} });
    return byLocale.get(locale);
  };

  try {
    let version = null;

    if (hasVersionWork) {
      version = await appstore.getEditableVersion(target);
      if (!version) {
        return res.status(409).json({
          ok: false,
          status: 409,
          message:
            "No editable version (Waiting for Review / Prepare for Submission).",
        });
      }
      const locales = await appstore.getVersionLocalizationsById(
        target,
        version.id,
      );
      if (locales.length === 0) {
        return res
          .status(404)
          .json({
            ok: false,
            status: 404,
            message: "The editable version has no localizations.",
          });
      }
      for (const loc of locales) {
        const entry = entryFor(loc.locale);
        entry.localizationId = loc.id;
        let translated = {};
        try {
          if (Object.keys(translatableSource).length > 0) {
            translated = await translate.translateFields(
              translatableSource,
              loc.locale,
            );
          }
        } catch (err) {
          markLocaleFail(
            entry,
            { message: `Translation failed: ${err.message}` },
            "translate",
          );
          continue;
        }
        const attributes = { ...translated, ...versionPassthrough };
        try {
          await appstore.updateLocalizationById(target, loc.id, attributes);
          Object.assign(entry.translated, attributes);
          console.log(
            `[ok] ${loc.locale}: version ${Object.keys(attributes).join(", ")}`,
          );
        } catch (err) {
          markLocaleFail(entry, err, "patch-version");
        }
      }
    }

    if (hasAppInfoWork) {
      const appInfo = await appstore.getEditableAppInfo(target);
      if (!appInfo) {
        return res
          .status(409)
          .json({
            ok: false,
            status: 409,
            message: "No editable App Info for the Privacy Policy URL.",
          });
      }
      const alocs = await appstore.getAppInfoLocalizations(target, appInfo.id);
      for (const loc of alocs) {
        const entry = entryFor(loc.locale);
        entry.appInfoLocalizationId = loc.id;
        try {
          await appstore.updateAppInfoLocalizationById(
            target,
            loc.id,
            appInfoPassthrough,
          );
          Object.assign(entry.translated, appInfoPassthrough);
          console.log(
            `[ok] ${loc.locale}: appInfo ${Object.keys(appInfoPassthrough).join(", ")}`,
          );
        } catch (err) {
          markLocaleFail(entry, err, "patch-appinfo");
        }
      }
    }

    const results = Array.from(byLocale.values());
    const allOk = results.length > 0 && results.every((r) => r.ok);
    res.status(allOk ? 200 : 207).json({
      ok: allOk,
      status: allOk ? 200 : 207,
      version,
      updatedFields: Object.keys(incoming),
      results,
    });
  } catch (err) {
    handleError(err, res, target.proxyUrl);
  }
});

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

// GET /screenshots — local screenshot files + the editable version's locales.
app.get("/screenshots", async (req, res) => {
  const target = getTarget(req, res);
  if (!target) return;
  try {
    let screenshots = [];
    let screenshotsError = null;
    try {
      screenshots = screenshotsLib.listLocalScreenshots(target.screenshotsDir);
    } catch (e) {
      screenshotsError = e.message;
    }

    const version = await appstore.getEditableVersion(target);
    const dir = target.screenshotsDir || null;
    const forcedDisplayType = process.env.SCREENSHOT_DISPLAY_TYPE || null;

    if (!version) {
      return res.status(409).json({
        ok: false,
        status: 409,
        message:
          "No editable version to attach screenshots to. Create or submit a new version first.",
        dir,
        forcedDisplayType,
        screenshots,
        screenshotsError,
      });
    }

    const locs = await appstore.getVersionLocalizationsById(target, version.id);
    res.json({
      ok: true,
      version,
      dir,
      forcedDisplayType,
      screenshots,
      screenshotsError,
      locales: locs.map((l) => l.locale),
    });
  } catch (err) {
    handleError(err, res, target.proxyUrl);
  }
});

// POST /screenshots/push — upload screenshots to the selected locales.
app.post("/screenshots/push", async (req, res) => {
  const target = getTarget(req, res);
  if (!target) return;
  const { locales, replace } = req.body || {};
  if (!Array.isArray(locales) || locales.length === 0) {
    return res
      .status(400)
      .json({
        ok: false,
        status: 400,
        message: 'Provide a non-empty "locales" array.',
      });
  }

  let screenshots;
  try {
    screenshots = screenshotsLib.listLocalScreenshots(target.screenshotsDir);
  } catch (e) {
    return res.status(400).json({ ok: false, status: 400, message: e.message });
  }
  const usable = screenshots.filter((s) => s.displayType && !s.error);
  if (usable.length === 0) {
    return res.status(400).json({
      ok: false,
      status: 400,
      message:
        "No usable screenshots — check the folder and image sizes (or set SCREENSHOT_DISPLAY_TYPE).",
    });
  }

  try {
    const version = await appstore.getEditableVersion(target);
    if (!version) {
      return res
        .status(409)
        .json({
          ok: false,
          status: 409,
          message: "No editable version to attach screenshots to.",
        });
    }
    const locs = await appstore.getVersionLocalizationsById(target, version.id);
    const idByLocale = new Map(locs.map((l) => [l.locale, l.id]));

    const results = [];
    for (const locale of locales) {
      const entry = { locale, ok: false };
      const localizationId = idByLocale.get(locale);
      if (!localizationId) {
        entry.status = 404;
        entry.message = "Locale is not on the editable version.";
        results.push(entry);
        continue;
      }
      try {
        const r = await screenshotsLib.pushToLocalization(
          target,
          localizationId,
          usable,
          {
            replace: replace !== false,
          },
        );
        entry.ok = true;
        entry.status = 200;
        entry.uploaded = r.uploaded;
        entry.sets = r.sets;
        console.log(`[ok] screenshots ${locale}: ${r.uploaded} uploaded`);
      } catch (err) {
        markLocaleFail(entry, err, "upload");
        console.error(`[error] screenshots ${locale}: ${entry.message}`);
      }
      results.push(entry);
    }

    const allOk = results.every((r) => r.ok);
    res.status(allOk ? 200 : 207).json({
      ok: allOk,
      status: allOk ? 200 : 207,
      version,
      usableCount: usable.length,
      results,
    });
  } catch (err) {
    handleError(err, res, target.proxyUrl);
  }
});

// ---------------------------------------------------------------------------
// A/B tests (Product Page Optimization experiments)
// ---------------------------------------------------------------------------

// "Treatment A" -> "A". The last whitespace-separated token, uppercased.
function variantLetter(name) {
  const tok = String(name || "").trim().split(/\s+/).pop() || "";
  return tok.toUpperCase();
}

// Local screenshots for a variant live in <screenshotsDirForAb>/<letter>.
function variantLocalScreenshots(target, letter) {
  if (!target.screenshotsDirForAb) {
    return { dir: null, screenshots: [], error: "No screenshotsDirForAb set for this app." };
  }
  const dir = path.join(target.screenshotsDirForAb, letter);
  try {
    return { dir, screenshots: screenshotsLib.listLocalScreenshots(dir), error: null };
  } catch (e) {
    return { dir, screenshots: [], error: e.message };
  }
}

// GET /abtests — experiments + their variants (with locales + local screenshots).
app.get("/abtests", async (req, res) => {
  const target = getTarget(req, res);
  if (!target) return;
  try {
    const experiments = await appstore.listExperiments(target);
    const out = [];
    for (const exp of experiments) {
      const treatments = await appstore.getExperimentTreatments(target, exp.id);
      const variants = [];
      let localeUnion = new Set();
      for (const tr of treatments) {
        const letter = variantLetter(tr.name);
        const locs = await appstore.getTreatmentLocalizations(target, tr.id);
        locs.forEach((l) => localeUnion.add(l.locale));
        const local = variantLocalScreenshots(target, letter);
        variants.push({
          treatmentId: tr.id,
          name: tr.name,
          letter,
          locales: locs.map((l) => l.locale),
          localDir: local.dir,
          localError: local.error,
          screenshots: local.screenshots,
          usableCount: local.screenshots.filter((s) => s.displayType && !s.error).length,
        });
      }
      out.push({
        id: exp.id,
        name: exp.name,
        state: exp.state,
        pretty: prettyState(exp.state),
        traffic: exp.traffic,
        variants,
        locales: [...localeUnion].sort(),
      });
    }
    res.json({
      ok: true,
      forcedDisplayType: process.env.SCREENSHOT_DISPLAY_TYPE || null,
      experiments: out,
    });
  } catch (err) {
    handleError(err, res, target.proxyUrl);
  }
});

// POST /abtests/screenshots/push — upload a variant's screenshots to the
// selected treatment localizations. Body: { experimentId, treatmentId, locales[], replace? }.
app.post("/abtests/screenshots/push", async (req, res) => {
  const target = getTarget(req, res);
  if (!target) return;
  const { experimentId, treatmentId, locales, replace } = req.body || {};
  if (!experimentId || !treatmentId) {
    return res.status(400).json({ ok: false, status: 400, message: "Provide experimentId and treatmentId." });
  }
  if (!Array.isArray(locales) || locales.length === 0) {
    return res.status(400).json({ ok: false, status: 400, message: 'Provide a non-empty "locales" array.' });
  }
  try {
    const treatments = await appstore.getExperimentTreatments(target, experimentId);
    const treatment = treatments.find((t) => t.id === treatmentId);
    if (!treatment) {
      return res.status(404).json({ ok: false, status: 404, message: "Treatment not found in this experiment." });
    }
    const letter = variantLetter(treatment.name);
    const local = variantLocalScreenshots(target, letter);
    if (local.error) {
      return res.status(400).json({ ok: false, status: 400, message: local.error });
    }
    const usable = local.screenshots.filter((s) => s.displayType && !s.error);
    if (usable.length === 0) {
      return res.status(400).json({
        ok: false,
        status: 400,
        message: `No usable screenshots in ${local.dir} — check images / sizes.`,
      });
    }

    const locs = await appstore.getTreatmentLocalizations(target, treatmentId);
    const idByLocale = new Map(locs.map((l) => [l.locale, l.id]));

    const results = [];
    for (const locale of locales) {
      const entry = { locale, ok: false };
      const locId = idByLocale.get(locale);
      if (!locId) {
        entry.status = 404;
        entry.message = "Locale is not on this variant.";
        results.push(entry);
        continue;
      }
      try {
        const r = await screenshotsLib.pushToTreatmentLocalization(target, locId, usable, {
          replace: replace !== false,
        });
        entry.ok = true;
        entry.status = 200;
        entry.uploaded = r.uploaded;
        entry.sets = r.sets;
        console.log(`[ok] A/B ${treatment.name} ${locale}: ${r.uploaded} uploaded`);
      } catch (err) {
        markLocaleFail(entry, err, "upload");
        console.error(`[error] A/B ${treatment.name} ${locale}: ${entry.message}`);
      }
      results.push(entry);
    }

    const allOk = results.every((r) => r.ok);
    res.status(allOk ? 200 : 207).json({
      ok: allOk,
      status: allOk ? 200 : 207,
      variant: treatment.name,
      usableCount: usable.length,
      results,
    });
  } catch (err) {
    handleError(err, res, target.proxyUrl);
  }
});

// ---------------------------------------------------------------------------
// Telegram status digest (all targets)
// ---------------------------------------------------------------------------

// Fetch the raw status of every target. Never throws — a target that errors is
// captured as { error: true, ... } so one bad app doesn't sink the whole poll.
// `includeGC` false skips the Game Center footprint (used for grey apps, which
// only need liveness — fewer requests to Apple).
async function collectStatuses(
  list = targets.all(),
  { includeGC = true, includeExperiments = true } = {},
) {
  const out = [];
  for (const t of list) {
    try {
      const [app_, v, sale] = await Promise.all([
        appstore.getApp(t),
        appstore.getLatestVersion(t),
        appstore.getSaleStatus(t),
      ]);
      const gc = includeGC ? await gameCenter.getFootprint(t) : undefined;
      // A/B tests (Product Page Optimization). null = couldn't read (carry
      // forward); [] = no tests; undefined = not fetched (grey).
      let experiments;
      if (includeExperiments) {
        try {
          experiments = await appstore.listExperiments(t);
        } catch (e) {
          experiments = null;
        }
      }
      out.push({
        id: t.id,
        name: app_.name,
        jira: t.jira,
        ignoreRemoved: t.ignoreRemoved,
        notPublishedYet: t.notPublishedYet,
        version: v, // { versionString, state, createdDate } | null
        forSale: sale ? sale.forSale : null,
        gc, // { enabled, groups, leaderboards, achievements } | { error } | undefined
        experiments, // [{ name, state, traffic }] | [] | null | undefined
        error: null,
      });
    } catch (err) {
      out.push({
        id: t.id,
        name: t.name,
        jira: t.jira,
        ignoreRemoved: t.ignoreRemoved,
        notPublishedYet: t.notPublishedYet,
        version: null,
        forSale: null,
        // network/proxy failures (no response) are transient — flagged so the
        // monitor can ignore them for change detection.
        error: {
          apple: !!err.response,
          status: err.response ? err.response.status : null,
          message: err.response ? `Apple ${err.response.status}` : err.message,
        },
      });
    }
  }
  return out;
}

// A compact signature of a target's status; a change here is what triggers a
// Telegram message. `null` means "carry the previous value forward" (transient
// network error — don't treat as a change).
function statusSignature(s) {
  if (s.error) return s.error.apple ? `apple-err:${s.error.status}` : null;
  const v = s.version;
  const state = v ? v.state : "NONE";
  const ver = v ? v.versionString : "-";
  // Fold in the Game Center footprint so any group / leaderboard / achievement
  // change (a keyword-injection fingerprint) also triggers a notification. If GC
  // couldn't be read this poll (transient), carry the whole target forward
  // (return null) rather than flap the signature and raise a false alarm.
  const gcSig = gameCenter.signature(s.gc);
  if (gcSig === null) return null;
  // A/B tests: null means we couldn't read them this poll -> carry forward.
  if (s.experiments === null) return null;
  const expSig = (s.experiments || [])
    .map((e) => `${e.name}:${e.state}`)
    .sort()
    .join(",");
  return `${state}|v${ver}|sale:${s.forSale}|${gcSig}|exp:${expSig}`;
}

// Render one target's block for the Telegram message. `since` is the tracked
// "in this status since" date (may be null when unknown).
function formatBlock(s, since) {
  const jira = s.jira ? `🎫 Jira: ${s.jira}` : null;
  if (s.error) {
    return [`📱 <b>${s.name}</b>`, jira, `⚠️ ${s.error.message}`]
      .filter(Boolean)
      .join("\n");
  }
  const rows = [`📱 <b>${s.name}</b>`];
  if (jira) rows.push(jira);
  const v = s.version;
  if (v) {
    rows.push(
      `${statusEmoji(v.state)} <b>${prettyState(v.state)}</b> — v${v.versionString}`,
    );
    if (since) {
      const ago = daysAgo(since);
      rows.push(`🗓 since ${formatDate(since)}${ago ? ` · ${ago}` : ""}`);
    }
  } else {
    rows.push("⚪ <b>No versions</b>");
  }
  // A/B tests (Product Page Optimization) — shown with the same status emoji as
  // the app, one line per running experiment.
  (s.experiments || []).forEach((e) => {
    const pct = e.traffic != null ? ` · ${e.traffic}%` : "";
    rows.push(
      `🧪 <b>A/B: ${e.name}</b> — ${statusEmoji(e.state)} ${prettyState(e.state)}${pct}`,
    );
  });
  if (s.forSale === false) {
    // A first release (v1.0 / 1.0.0) that isn't for sale hasn't been *removed* —
    // it simply hasn't been published yet, so you can't find it by link. Only
    // an app that was already out there and then pulled is "Removed".
    // `ignoreRemoved` is a per-app exception that suppresses the Removed line;
    // `notPublishedYet` forces the first-release line whatever the version.
    const ver = v ? v.versionString : "";
    const firstRelease =
      s.notPublishedYet || ver === "1.0" || ver === "1.0.0";
    if (firstRelease) {
      rows.push("🆕 <b>Not published yet</b> (first release)");
    } else if (!s.ignoreRemoved) {
      rows.push("🚫 <b>Removed from the App Store</b>");
    }
  }
  // Game Center footprint — the keyword-injection surface. Live leaderboards /
  // achievements are the actual (indexed) keyword carriers; groups alone are the
  // durable leftover trace. Draft submissions can't be read via the API.
  const gc = s.gc;
  if (gc && !gc.error && gc.enabled) {
    const lb = gc.leaderboards || [];
    const ach = gc.achievements || [];
    if (lb.length || ach.length) {
      rows.push(
        `🎮 <b>Game Center content live</b> — LB:${lb.length} · ACH:${ach.length}`,
      );
      const fmt = (o) =>
        `${o.ref}${o.names && o.names.length ? ` — “${o.names.join("” / “")}”` : ""}`;
      lb.forEach((o) => rows.push(`   🏆 ${fmt(o)}`));
      ach.forEach((o) => rows.push(`   🎖 ${fmt(o)}`));
    } else if (gc.groups && gc.groups.length) {
      rows.push(`🎮 GC groups: ${gc.groups.join(", ")} (no live objects)`);
    }
  }
  return rows.join("\n");
}

// Build the full digest text from statuses, using read-only "since" dates.
// A blank line between apps for clearer separation in the chat.
function formatDigest(statuses) {
  return statuses
    .map((s) => formatBlock(s, statusStore.peekSince(s.id)))
    .join("\n\n");
}

// Non-grey apps (isGrey=false): polled every tick. If ANY of them changed since
// last poll, send ONE message with the CURRENT status of ALL non-grey apps.
async function runNonGrey(list) {
  if (list.length === 0) return null;
  const statuses = await collectStatuses(list, { includeGC: true });
  let anyChanged = false;
  const sinceById = {};
  for (const s of statuses) {
    const sig = statusSignature(s); // includes Game Center footprint
    if (sig === null) {
      // Transient failure (network / GC unreadable) — carry forward.
      sinceById[s.id] = statusStore.peekSince(s.id);
      continue;
    }
    const state = s.error ? "ERROR" : s.version ? s.version.state : "NONE";
    const seed = s.version ? s.version.createdDate : undefined;
    const version = s.version ? s.version.versionString : "";
    const res = statusStore.track(s.id, state, seed, sig, version);
    sinceById[s.id] = res.since;
    if (res.changed) anyChanged = true;
  }
  if (!anyChanged) return null;
  // Whole group, current statuses (that's what the user asked for).
  return statuses.map((s) => formatBlock(s, sinceById[s.id])).join("\n\n");
}

// Grey apps (isGrey=true): checked once per STABLE_INTERVAL_HOURS for TWO things
// only — (1) liveness and (2) Game Center footprint. Alert when the app becomes
// NOT alive (removed from the store), OR when its Game Center content changes (a
// keyword-injection fingerprint). Version/state churn is ignored. The signature
// is "grey~~alive:<bool>~~<gcSig>"; we compare each part ourselves so we can
// alert on death (only on the transition into dead) and on any GC change.
async function runGrey(list, nowMs) {
  const due = list.filter((t) => greyDue(statusStore.getRecord(t.id), nowMs));
  if (due.length === 0) return null;
  const alerts = [];
  for (const t of due) {
    const [s] = await collectStatuses([t], {
      includeGC: true,
      includeExperiments: false,
    });
    if (s.error) {
      // Couldn't even read the app — don't guess; hold the cadence.
      statusStore.markPolled(t.id);
      continue;
    }
    const prev = statusStore.getRecord(t.id);
    const prevParts = (prev && prev.sig ? prev.sig : "").split("~~");
    const hasBaseline = prevParts.length >= 3;
    const prevAlive = prevParts[1]; // "alive:true" | "alive:false" | undefined
    const prevGc = prevParts[2]; // gcSig | undefined

    // "Removed from the store" = not for sale anywhere AND the app was actually
    // published at some point (some version reached READY_FOR_SALE). A first
    // release that simply hasn't launched yet is also forSale=false — but that's
    // "not published yet", NOT a removal, so it must not fire a death alert.
    let everPublished = false;
    try {
      const versions = await appstore.listAppStoreVersions(t);
      everPublished = versions.some((v) => v.state === "READY_FOR_SALE");
    } catch (e) {
      // If we can't tell, err on the safe side: treat as "not removed".
      everPublished = false;
    }
    // ignoreRemoved / notPublishedYet: per-app exceptions — never treat this
    // app as removed.
    const removed =
      s.forSale === false &&
      everPublished &&
      !s.ignoreRemoved &&
      !s.notPublishedYet;
    const alive = !removed;
    const gcSig = gameCenter.signature(s.gc); // null if GC unreadable this poll
    // If GC couldn't be read, carry the previous GC part forward (don't false-alarm).
    const gcPart = gcSig === null ? prevGc || "gc:?" : gcSig;
    const sig = `grey~~alive:${alive}~~${gcPart}`;

    const state = s.version ? s.version.state : "NONE";
    const seed = s.version ? s.version.createdDate : undefined;
    const version = s.version ? s.version.versionString : "";
    const res = statusStore.track(t.id, state, seed, sig, version);

    const becameDead = !alive && prevAlive !== "alive:false"; // transition (or first-seen dead)
    const gcChanged = gcSig !== null && hasBaseline && prevGc !== gcSig;
    if (becameDead || gcChanged) alerts.push(formatBlock(s, res.since));
  }
  return alerts.length ? alerts.join("\n\n") : null;
}

// The interval monitor. Non-grey apps are watched closely (every tick, whole
// group reported on any change); grey apps only get a daily liveness check.
async function checkAndNotify() {
  try {
    const nowMs = Date.now();
    const all = targets.all();
    const parts = [];
    const nonGrey = await runNonGrey(all.filter((t) => !t.isGrey));
    if (nonGrey) parts.push(nonGrey);
    const grey = await runGrey(all.filter((t) => t.isGrey), nowMs);
    if (grey) parts.push(grey);

    if (parts.length === 0) {
      console.log("[monitor] no changes — nothing sent.");
      return;
    }
    await telegram.notify(parts.join("\n\n———\n\n"));
    console.log("[telegram] change detected — sent.");
  } catch (err) {
    console.error(`[monitor] failed: ${err.message}`);
  }
}

// GET /telegram/test — send the current digest now (manual; always sends,
// read-only — does NOT touch the change-detection baseline).
app.get("/telegram/test", async (_req, res) => {
  const st = telegram.status();
  if (!st.ok)
    return res.status(400).json({ ok: false, status: 400, message: st.reason });
  try {
    const statuses = await collectStatuses();
    const text = formatDigest(statuses);
    await telegram.notify(text);
    res.json({ ok: true, sent: text });
  } catch (err) {
    const status = err.response ? err.response.status : 500;
    const detail = err.response
      ? JSON.stringify(err.response.data)
      : err.message;
    res.status(status).json({ ok: false, status, message: detail });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[server] Listening on http://0.0.0.0:${PORT}`);
  console.log(`[server] ${targets.list().length} app target(s) configured.`);

  const proxyTarget = proxy.describe();
  console.log(
    proxyTarget
      ? `[proxy] Default proxy: ${proxyTarget} (per-target overrides apply).`
      : "[proxy] No default PROXY_URL — requests go out directly unless a target sets one.",
  );

  console.log("");
  discoverAll().catch((err) =>
    console.error(`[discover] Skipped — ${err.message}`),
  );

  // Telegram monitor: poll ALL targets every STATUS_INTERVAL_MINUTES (30) but
  // only message when a status actually changed (first run sets the baseline).
  const intervalMin = Number(process.env.STATUS_INTERVAL_MINUTES) || 30;
  const tg = telegram.status();
  if (tg.ok) {
    console.log(
      `[telegram] Monitor ON — non-grey apps every ${intervalMin} min (group digest on any change); grey apps liveness + Game Center every ${STABLE_INTERVAL_HOURS}h.`,
    );
    checkAndNotify();
    setInterval(checkAndNotify, intervalMin * 60 * 1000);
  } else {
    console.log(`[telegram] Monitor OFF — ${tg.reason}`);
  }
});
