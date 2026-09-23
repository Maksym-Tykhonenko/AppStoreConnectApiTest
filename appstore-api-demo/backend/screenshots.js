// ---------------------------------------------------------------------------
// screenshots.js
// ---------------------------------------------------------------------------
// Uploads screenshots from a local folder to App Store Connect, for one or
// more locales of the editable version.
//
// Apple's screenshot upload is a 3-step flow per file:
//   1. Reserve  — POST /v1/appScreenshots  (returns uploadOperations)
//   2. Upload   — PUT the file bytes to each uploadOperation URL
//   3. Commit   — PATCH /v1/appScreenshots/{id} { uploaded:true, sourceFileChecksum }
//
// Screenshots live in an appScreenshotSet, one per (localization, displayType).
// The file's pixel size must match the display type Apple expects.
//
// Folder + (optional) forced display type come from .env:
//   SCREENSHOTS_DIR         e.g. ./screenshots
//   SCREENSHOT_DISPLAY_TYPE e.g. APP_IPHONE_67  (optional — else inferred by size)
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const sizeOf = require("image-size");
const { authedRequest } = require("./appstore");
const proxy = require("./proxy");

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg"]);

// Portrait "widthxheight" (width < height) -> App Store screenshotDisplayType.
// Landscape shots normalize to the same key. If a size isn't here, the user can
// force one via SCREENSHOT_DISPLAY_TYPE.
const DIMENSION_MAP = {
  "1320x2868": "APP_IPHONE_69",
  "1290x2796": "APP_IPHONE_67",
  // 1284x2778 is accepted by Apple for the 6.5" display (along with 1242x2688).
  // Apple has folded the old 6.7" class into 6.5"/6.9", so map it to 6.5".
  "1284x2778": "APP_IPHONE_65",
  "1242x2688": "APP_IPHONE_65",
  "1179x2556": "APP_IPHONE_61",
  "1170x2532": "APP_IPHONE_61",
  "1242x2208": "APP_IPHONE_55",
  "750x1334": "APP_IPHONE_47",
  "2064x2752": "APP_IPAD_PRO_3GEN_129",
  "2048x2732": "APP_IPAD_PRO_129",
  "1668x2388": "APP_IPAD_PRO_3GEN_11",
  "1640x2360": "APP_IPAD_PRO_3GEN_11",
};

function inferDisplayType(width, height) {
  const [a, b] = [width, height].sort((x, y) => x - y);
  return DIMENSION_MAP[`${a}x${b}`] || null;
}

/**
 * Read the screenshots folder and describe each image:
 * [{ fileName, path, size, width, height, displayType, error }].
 */
function listLocalScreenshots(dir) {
  const forced = process.env.SCREENSHOT_DISPLAY_TYPE || null;
  if (!dir) {
    throw new Error("No screenshots folder set (screenshotsDir / SCREENSHOTS_DIR).");
  }
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) {
    throw new Error(`Screenshots folder not found: ${abs}`);
  }

  const files = fs
    .readdirSync(abs)
    .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()))
    .sort();

  return files.map((f) => {
    const full = path.join(abs, f);
    const entry = {
      fileName: f,
      path: full,
      size: fs.statSync(full).size,
      width: null,
      height: null,
      displayType: null,
      error: null,
    };
    try {
      const d = sizeOf(full);
      entry.width = d.width;
      entry.height = d.height;
      entry.displayType = forced || inferDisplayType(d.width, d.height);
      if (!entry.displayType) {
        entry.error = `Unrecognized size ${d.width}x${d.height} — set SCREENSHOT_DISPLAY_TYPE.`;
      }
    } catch (e) {
      entry.error = `Cannot read image: ${e.message}`;
    }
    return entry;
  });
}

// --- Apple screenshot API calls -------------------------------------------

async function getScreenshotSets(target, localizationId) {
  const data = await authedRequest(target, {
    method: "get",
    url: `/v1/appStoreVersionLocalizations/${localizationId}/appScreenshotSets`,
    params: { limit: 50 },
  });
  return (data.data || []).map((s) => ({
    id: s.id,
    displayType: (s.attributes || {}).screenshotDisplayType,
  }));
}

async function createScreenshotSet(target, localizationId, displayType) {
  const body = {
    data: {
      type: "appScreenshotSets",
      attributes: { screenshotDisplayType: displayType },
      relationships: {
        appStoreVersionLocalization: {
          data: { type: "appStoreVersionLocalizations", id: localizationId },
        },
      },
    },
  };
  const data = await authedRequest(target, { method: "post", url: "/v1/appScreenshotSets", data: body });
  return data.data.id;
}

async function ensureScreenshotSet(target, localizationId, displayType) {
  const sets = await getScreenshotSets(target, localizationId);
  const found = sets.find((s) => s.displayType === displayType);
  return found ? found.id : createScreenshotSet(target, localizationId, displayType);
}

async function listScreenshotsInSet(target, setId) {
  const data = await authedRequest(target, {
    method: "get",
    url: `/v1/appScreenshotSets/${setId}/appScreenshots`,
    params: { limit: 50 },
  });
  return (data.data || []).map((s) => s.id);
}

async function deleteScreenshot(target, id) {
  return authedRequest(target, { method: "delete", url: `/v1/appScreenshots/${id}` });
}

async function reserveScreenshot(target, setId, fileName, fileSize) {
  const body = {
    data: {
      type: "appScreenshots",
      attributes: { fileName, fileSize },
      relationships: {
        appScreenshotSet: { data: { type: "appScreenshotSets", id: setId } },
      },
    },
  };
  const data = await authedRequest(target, { method: "post", url: "/v1/appScreenshots", data: body });
  return data.data; // { id, attributes: { uploadOperations, ... } }
}

// Upload raw bytes to the reserved upload URLs (pre-signed asset URLs with their
// own headers — no Bearer token). Routed through the target's proxy if set.
async function uploadBytes(uploadOperations, buffer, proxyUrl) {
  for (const op of uploadOperations || []) {
    const headers = {};
    (op.requestHeaders || []).forEach((h) => {
      headers[h.name] = h.value;
    });
    const chunk = buffer.subarray(op.offset, op.offset + op.length);
    await axios({
      method: op.method || "PUT",
      url: op.url,
      data: chunk,
      headers,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 120000,
      ...proxy.axiosProxyConfig(proxyUrl),
    });
  }
}

async function commitScreenshot(target, id, checksum) {
  const body = {
    data: {
      type: "appScreenshots",
      id,
      attributes: { uploaded: true, sourceFileChecksum: checksum },
    },
  };
  return authedRequest(target, { method: "patch", url: `/v1/appScreenshots/${id}`, data: body });
}

/**
 * Upload the given screenshots to one localization. Groups them by display
 * type into sets. With replace=true (default), existing screenshots in each
 * touched set are deleted first.
 *
 * @returns {Promise<{uploaded:number, sets:object}>}
 */
async function pushToLocalization(target, localizationId, screenshots, opts = {}) {
  const replace = opts.replace !== false;

  const byType = {};
  for (const s of screenshots) {
    if (!s.displayType || s.error) continue;
    (byType[s.displayType] = byType[s.displayType] || []).push(s);
  }

  const result = { uploaded: 0, sets: {} };
  for (const displayType of Object.keys(byType)) {
    const setId = await ensureScreenshotSet(target, localizationId, displayType);

    if (replace) {
      const existing = await listScreenshotsInSet(target, setId);
      for (const id of existing) await deleteScreenshot(target, id);
    }

    let count = 0;
    for (const s of byType[displayType]) {
      const buffer = fs.readFileSync(s.path);
      const checksum = crypto.createHash("md5").update(buffer).digest("hex");
      const reserved = await reserveScreenshot(target, setId, s.fileName, buffer.length);
      await uploadBytes(reserved.attributes.uploadOperations, buffer, target.proxyUrl);
      await commitScreenshot(target, reserved.id, checksum);
      count++;
    }
    result.sets[displayType] = count;
    result.uploaded += count;
  }
  return result;
}

// --- A/B test (experiment treatment) screenshots ---------------------------
// Same reserve→upload→commit flow, but the screenshot set is anchored to an
// appStoreVersionExperimentTreatmentLocalization instead of a version locale.

async function getTreatmentScreenshotSets(target, treatmentLocId) {
  const data = await authedRequest(target, {
    method: "get",
    url: `/v1/appStoreVersionExperimentTreatmentLocalizations/${treatmentLocId}/appScreenshotSets`,
    params: { limit: 50 },
  });
  return (data.data || []).map((s) => ({
    id: s.id,
    displayType: (s.attributes || {}).screenshotDisplayType,
  }));
}

async function createTreatmentScreenshotSet(target, treatmentLocId, displayType) {
  const body = {
    data: {
      type: "appScreenshotSets",
      attributes: { screenshotDisplayType: displayType },
      relationships: {
        appStoreVersionExperimentTreatmentLocalization: {
          data: {
            type: "appStoreVersionExperimentTreatmentLocalizations",
            id: treatmentLocId,
          },
        },
      },
    },
  };
  const data = await authedRequest(target, { method: "post", url: "/v1/appScreenshotSets", data: body });
  return data.data.id;
}

async function ensureTreatmentScreenshotSet(target, treatmentLocId, displayType) {
  const sets = await getTreatmentScreenshotSets(target, treatmentLocId);
  const found = sets.find((s) => s.displayType === displayType);
  return found ? found.id : createTreatmentScreenshotSet(target, treatmentLocId, displayType);
}

/**
 * Upload screenshots to one A/B-test treatment localization. Mirrors
 * pushToLocalization but anchors sets to the treatment localization.
 */
async function pushToTreatmentLocalization(target, treatmentLocId, screenshots, opts = {}) {
  const replace = opts.replace !== false;

  const byType = {};
  for (const s of screenshots) {
    if (!s.displayType || s.error) continue;
    (byType[s.displayType] = byType[s.displayType] || []).push(s);
  }

  const result = { uploaded: 0, sets: {} };
  for (const displayType of Object.keys(byType)) {
    const setId = await ensureTreatmentScreenshotSet(target, treatmentLocId, displayType);

    if (replace) {
      const existing = await listScreenshotsInSet(target, setId);
      for (const id of existing) await deleteScreenshot(target, id);
    }

    let count = 0;
    for (const s of byType[displayType]) {
      const buffer = fs.readFileSync(s.path);
      const checksum = crypto.createHash("md5").update(buffer).digest("hex");
      const reserved = await reserveScreenshot(target, setId, s.fileName, buffer.length);
      await uploadBytes(reserved.attributes.uploadOperations, buffer, target.proxyUrl);
      await commitScreenshot(target, reserved.id, checksum);
      count++;
    }
    result.sets[displayType] = count;
    result.uploaded += count;
  }
  return result;
}

module.exports = {
  listLocalScreenshots,
  inferDisplayType,
  pushToLocalization,
  getTreatmentScreenshotSets,
  pushToTreatmentLocalization,
};
