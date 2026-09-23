// ---------------------------------------------------------------------------
// appstore.js
// ---------------------------------------------------------------------------
// Thin wrapper around the official App Store Connect REST API.
//
//   Base URL:  https://api.appstoreconnect.apple.com
//   Docs:      https://developer.apple.com/documentation/appstoreconnectapi
//
// Every function takes a `target` — one app + the developer-account credentials
// that reach it: { issuerId, keyId, privateKeyPath, appId, proxyUrl }. This lets
// the backend work with many apps across many accounts at once (see targets.js).
//
// Requests are authenticated with a per-account Bearer JWT (see jwt.js) and go
// through the target's proxy if set. On a 401 we mint a fresh token and retry
// exactly once.
// ---------------------------------------------------------------------------

const axios = require("axios");
const { getToken, invalidateToken } = require("./jwt");
const proxy = require("./proxy");

const BASE_URL = "https://api.appstoreconnect.apple.com";

const client = axios.create({ baseURL: BASE_URL, timeout: 20000 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Transient failures worth retrying (proxy hiccups, gateway errors). We only
// retry these for idempotent GETs — retrying a POST/PATCH/DELETE that returned
// a 502 could double-apply the change.
function isTransient(err) {
  const status = err.response && err.response.status;
  return !err.response || [502, 503, 504].includes(status);
}

/**
 * Authenticated request to Apple for a given target. Attaches that target's
 * Bearer token + proxy; on 401 refreshes the token and retries once; on a
 * transient error (proxy/gateway) retries an idempotent GET a few times with
 * backoff before giving up.
 */
async function authedRequest(target, config, isRetry = false, attempt = 0) {
  const token = getToken(target);
  try {
    const response = await client.request({
      ...config,
      ...proxy.axiosProxyConfig(target.proxyUrl), // per-target proxy if set
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(config.headers || {}),
      },
    });
    return response.data;
  } catch (err) {
    const status = err.response && err.response.status;
    if (status === 401 && !isRetry) {
      console.warn(`[appstore] 401 for key ${target.keyId} — refreshing JWT, retrying once.`);
      invalidateToken(target);
      return authedRequest(target, config, true, attempt);
    }
    const method = (config.method || "get").toLowerCase();
    if (method === "get" && isTransient(err) && attempt < 3) {
      await sleep(500 * (attempt + 1));
      return authedRequest(target, config, isRetry, attempt + 1);
    }
    throw err;
  }
}

// App Store localizations supported for version metadata (to compute which
// locales are not yet added). If Apple rejects a specific one on create, the
// per-locale result surfaces it.
const APP_STORE_LOCALES = [
  "ar-SA", "ca", "cs", "da", "de-DE", "el", "en-AU", "en-CA", "en-GB", "en-US",
  "es-ES", "es-MX", "fi", "fr-CA", "fr-FR", "he", "hi", "hr", "hu", "id", "it",
  "ja", "ko", "ms", "nl-NL", "no", "pl", "pt-BR", "pt-PT", "ro", "ru", "sk",
  "sl-SI", "sv", "th", "tr", "uk", "vi", "zh-Hans", "zh-Hant",
  "bn-BD", "gu-IN", "kn-IN", "ml-IN", "mr-IN", "or-IN", "pa-IN", "ta-IN",
  "te-IN", "ur-PK",
];

// Version states in which description/keywords/whatsNew are editable. Ordered
// by preference when picking the editable version.
const EDITABLE_VERSION_STATES = [
  "WAITING_FOR_REVIEW",
  "PREPARE_FOR_SUBMISSION",
  "METADATA_REJECTED",
  "REJECTED",
  "DEVELOPER_REJECTED",
  "INVALID_BINARY",
];

// --- App -------------------------------------------------------------------

/** GET the app resource (name, bundle id, primary locale, ...). */
async function getApp(target) {
  const data = await authedRequest(target, {
    method: "get",
    url: `/v1/apps/${target.appId}`,
  });
  const a = (data && data.data && data.data.attributes) || {};
  return {
    id: target.appId,
    name: a.name,
    bundleId: a.bundleId,
    sku: a.sku,
    primaryLocale: a.primaryLocale,
  };
}

// --- Versions --------------------------------------------------------------

/** List the app's versions: [{ id, versionString, state, createdDate }]. */
async function listAppStoreVersions(target) {
  const data = await authedRequest(target, {
    method: "get",
    url: `/v1/apps/${target.appId}/appStoreVersions`,
    params: { limit: 50 },
  });
  const items = (data && data.data) || [];
  return items.map((it) => ({
    id: it.id,
    versionString: (it.attributes || {}).versionString,
    state: (it.attributes || {}).appStoreState,
    createdDate: (it.attributes || {}).createdDate,
  }));
}

/**
 * A/B tests (Product Page Optimization experiments) for the app.
 * Returns [{ name, state, traffic }] — empty array if none. Throws on error so
 * the caller can distinguish "no experiments" from "couldn't read".
 */
async function listExperiments(target) {
  const data = await authedRequest(target, {
    method: "get",
    url: `/v1/apps/${target.appId}/appStoreVersionExperimentsV2`,
    params: { limit: 50 },
  });
  const items = (data && data.data) || [];
  return items.map((x) => ({
    id: x.id,
    name: (x.attributes || {}).name,
    state: (x.attributes || {}).state,
    traffic: (x.attributes || {}).trafficProportion,
  }));
}

/** The treatments (A/B variants) of an experiment: [{ id, name }]. The
 * experiment resource lives under /v2/. */
async function getExperimentTreatments(target, experimentId) {
  const data = await authedRequest(target, {
    method: "get",
    url: `/v2/appStoreVersionExperiments/${experimentId}/appStoreVersionExperimentTreatments`,
    params: { limit: 50 },
  });
  return ((data && data.data) || []).map((x) => ({
    id: x.id,
    name: (x.attributes || {}).name,
  }));
}

/** A treatment's per-locale localizations: [{ id, locale }]. */
async function getTreatmentLocalizations(target, treatmentId) {
  const data = await authedRequest(target, {
    method: "get",
    url: `/v1/appStoreVersionExperimentTreatments/${treatmentId}/appStoreVersionExperimentTreatmentLocalizations`,
    params: { limit: 200 },
  });
  return ((data && data.data) || []).map((x) => ({
    id: x.id,
    locale: (x.attributes || {}).locale,
  }));
}

/** The most recently created version (for status reporting). */
async function getLatestVersion(target) {
  const versions = await listAppStoreVersions(target);
  if (versions.length === 0) return null;
  return versions
    .slice()
    .sort(
      (a, b) =>
        (b.createdDate ? Date.parse(b.createdDate) : 0) -
        (a.createdDate ? Date.parse(a.createdDate) : 0)
    )[0];
}

/** The editable version (WAITING_FOR_REVIEW / PREPARE_FOR_SUBMISSION / ...) or null. */
async function getEditableVersion(target) {
  const versions = await listAppStoreVersions(target);
  for (const state of EDITABLE_VERSION_STATES) {
    const match = versions.find((v) => v.state === state);
    if (match) return match;
  }
  return null;
}

/**
 * App-level sale status. A version can sit in WAITING_FOR_REVIEW (or even show
 * READY_FOR_SALE) while the app itself has been pulled from the store — Apple
 * reflects that per-territory with a `CANNOT_SELL` content status, NOT in the
 * version's appStoreState. We page the territory availabilities and treat the
 * app as "for sale" if ANY territory is available and not CANNOT_SELL.
 *
 * Returns { forSale, sellableCount, checked, blocked }:
 *   forSale === true   at least one territory can sell it (healthy),
 *   forSale === false  no territory can sell it (removed / cannot sell),
 *   forSale === null   couldn't determine (no availability record / API error).
 */
async function getSaleStatus(target) {
  let url = `/v2/appAvailabilities/${target.appId}/territoryAvailabilities?limit=50`;
  let checked = 0;
  let sellableCount = 0;
  const blocked = new Set();
  for (let page = 0; page < 12 && url; page++) {
    let data;
    try {
      data = await authedRequest(target, { method: "get", url });
    } catch (err) {
      return {
        forSale: null,
        sellableCount: 0,
        checked,
        blocked: [],
        error: (err.response && err.response.status) || err.code || err.message,
      };
    }
    const items = (data && data.data) || [];
    for (const it of items) {
      const at = it.attributes || {};
      checked++;
      const statuses = at.contentStatuses || [];
      if (at.available && !statuses.includes("CANNOT_SELL")) sellableCount++;
      else statuses.forEach((s) => blocked.add(s));
    }
    // Found a sellable territory — the app is live, no need to page further.
    if (sellableCount > 0) return { forSale: true, sellableCount, checked, blocked: [] };
    url = (data.links && data.links.next) || null;
  }
  return { forSale: false, sellableCount, checked, blocked: [...blocked] };
}

// --- Version localizations -------------------------------------------------

/** List a version's localizations: [{ id, locale, attributes }]. */
async function getVersionLocalizationsById(target, versionId) {
  if (!versionId) throw new Error("A version id is required.");
  const data = await authedRequest(target, {
    method: "get",
    url: `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`,
    params: { limit: 50 },
  });
  const items = (data && data.data) || [];
  return items.map((it) => ({
    id: it.id,
    locale: (it.attributes || {}).locale,
    attributes: it.attributes || {},
  }));
}

/** Create a new (empty) localization for a locale on a version. */
async function createVersionLocalization(target, versionId, locale) {
  if (!versionId || !locale) throw new Error("versionId and locale are required.");
  const body = {
    data: {
      type: "appStoreVersionLocalizations",
      attributes: { locale },
      relationships: {
        appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
      },
    },
  };
  return authedRequest(target, {
    method: "post",
    url: "/v1/appStoreVersionLocalizations",
    data: body,
  });
}

/** PATCH a version localization (e.g. { promotionalText, keywords, ... }). */
async function updateLocalizationById(target, localizationId, attributes) {
  if (!localizationId) throw new Error("A localization id is required.");
  const body = {
    data: { type: "appStoreVersionLocalizations", id: localizationId, attributes },
  };
  return authedRequest(target, {
    method: "patch",
    url: `/v1/appStoreVersionLocalizations/${localizationId}`,
    data: body,
  });
}

// --- App Info (privacyPolicyUrl, name, subtitle) ---------------------------

/** List the app's appInfos: [{ id, state }]. */
async function listAppInfos(target) {
  const data = await authedRequest(target, {
    method: "get",
    url: `/v1/apps/${target.appId}/appInfos`,
  });
  const items = (data && data.data) || [];
  return items.map((it) => ({
    id: it.id,
    state: (it.attributes || {}).appStoreState,
  }));
}

/** The editable appInfo (prefers an editable state; else the first) or null. */
async function getEditableAppInfo(target) {
  const infos = await listAppInfos(target);
  for (const state of EDITABLE_VERSION_STATES) {
    const match = infos.find((i) => i.state === state);
    if (match) return match;
  }
  return infos[0] || null;
}

/** List an appInfo's localizations: [{ id, locale, attributes }]. */
async function getAppInfoLocalizations(target, appInfoId) {
  if (!appInfoId) throw new Error("An appInfo id is required.");
  const data = await authedRequest(target, {
    method: "get",
    url: `/v1/appInfos/${appInfoId}/appInfoLocalizations`,
    params: { limit: 50 },
  });
  const items = (data && data.data) || [];
  return items.map((it) => ({
    id: it.id,
    locale: (it.attributes || {}).locale,
    attributes: it.attributes || {},
  }));
}

/** PATCH an appInfoLocalization (e.g. { privacyPolicyUrl }). */
async function updateAppInfoLocalizationById(target, localizationId, attributes) {
  if (!localizationId) throw new Error("An appInfoLocalization id is required.");
  const body = {
    data: { type: "appInfoLocalizations", id: localizationId, attributes },
  };
  return authedRequest(target, {
    method: "patch",
    url: `/v1/appInfoLocalizations/${localizationId}`,
    data: body,
  });
}

module.exports = {
  authedRequest,
  getApp,
  listAppStoreVersions,
  getLatestVersion,
  getEditableVersion,
  getSaleStatus,
  listExperiments,
  getExperimentTreatments,
  getTreatmentLocalizations,
  getVersionLocalizationsById,
  createVersionLocalization,
  updateLocalizationById,
  listAppInfos,
  getEditableAppInfo,
  getAppInfoLocalizations,
  updateAppInfoLocalizationById,
  APP_STORE_LOCALES,
};
