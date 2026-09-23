// ---------------------------------------------------------------------------
// translate.js
// ---------------------------------------------------------------------------
// Translates App Store metadata into the language of a given App Store locale,
// using the official OpenAI SDK.
//
//   Docs: https://platform.openai.com/docs
//   Model: process.env.OPENAI_MODEL (default "gpt-4o-mini")
//
// The OpenAI client reads credentials from the environment (OPENAI_API_KEY).
// We never hardcode a key.
// ---------------------------------------------------------------------------

const OpenAI = require("openai");
const proxy = require("./proxy");

// Lazily create the client so the server can boot even when OPENAI_API_KEY is
// not set (the GET endpoints don't need translation). The client is only built
// the first time we actually translate — and `new OpenAI()` throws a clear
// error if no key is available.
let client = null;
function getClient() {
  if (!client) {
    const agent = proxy.getAgent(); // route via PROXY_URL if set
    // Reads OPENAI_API_KEY automatically.
    client = new OpenAI(agent ? { httpAgent: agent } : {});
  }
  return client;
}

// The chat model used for translation. Override via OPENAI_MODEL in .env.
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Map common App Store locale codes to human-readable language names so we can
// give the model a clear instruction. Falls back to the raw locale code.
const LOCALE_TO_LANGUAGE = {
  "en-US": "English (United States)",
  "en-GB": "English (United Kingdom)",
  "en-AU": "English (Australia)",
  "en-CA": "English (Canada)",
  "fr-FR": "French (France)",
  "fr-CA": "French (Canada)",
  "de-DE": "German",
  it: "Italian",
  "es-ES": "Spanish (Spain)",
  "es-MX": "Spanish (Mexico)",
  "pt-BR": "Portuguese (Brazil)",
  "pt-PT": "Portuguese (Portugal)",
  "nl-NL": "Dutch",
  ja: "Japanese",
  ko: "Korean",
  "zh-Hans": "Simplified Chinese",
  "zh-Hant": "Traditional Chinese",
  ru: "Russian",
  uk: "Ukrainian",
  pl: "Polish",
  tr: "Turkish",
  sv: "Swedish",
  da: "Danish",
  fi: "Finnish",
  no: "Norwegian",
  cs: "Czech",
  sk: "Slovak",
  hu: "Hungarian",
  ro: "Romanian",
  el: "Greek",
  he: "Hebrew",
  th: "Thai",
  vi: "Vietnamese",
  id: "Indonesian",
  ms: "Malay",
  "ar-SA": "Arabic",
  hi: "Hindi",
  "kn-IN": "Kannada",
  "bn-BD": "Bengali",
  "ur-PK": "Urdu",
  ca: "Catalan",
  hr: "Croatian",
};

function localeToLanguage(locale) {
  return LOCALE_TO_LANGUAGE[locale] || locale;
}

// Apple's Promotional Text limit. Translations (e.g. French) are often longer
// than the source, so we trim them to fit before sending to Apple.
const PROMO_MAX = 170;

/**
 * Trim text to at most `maxLen` characters WITHOUT cutting a word in half:
 * cut at `maxLen`, then back off to the last whitespace. If there's no space
 * in range (one very long word), hard-cut at `maxLen`. Trailing whitespace and
 * dangling punctuation (",", ";", ":") left by the cut are removed.
 */
function truncateAtWord(text, maxLen = PROMO_MAX) {
  if (typeof text !== "string" || text.length <= maxLen) {
    return text;
  }
  const slice = text.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return cut.replace(/[\s,;:]+$/, "");
}

/**
 * Translate `text` into the language of `targetLocale`.
 * If the text is already in that language, the model returns it unchanged.
 *
 * @param {string} text - the source promotional text.
 * @param {string} targetLocale - App Store locale code, e.g. "fr-FR".
 * @returns {Promise<string>} the translated text.
 */
async function translateText(text, targetLocale) {
  const language = localeToLanguage(targetLocale);

  const completion = await getClient().chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are a professional App Store localization translator. Translate the " +
          "user's app Promotional Text into the requested target language, preserving " +
          "meaning, tone, and marketing intent. Keep it concise (ideally within 170 " +
          "characters). If the text is already in the target language, return it " +
          "unchanged. Return ONLY the translated text — no quotes, labels, notes, or " +
          "explanations.",
      },
      {
        role: "user",
        content: `Target language: ${language}\n\nPromotional Text:\n${text}`,
      },
    ],
  });

  const translated = (completion.choices[0].message.content || "").trim();

  // Translations can exceed Apple's 170-char limit — trim at a word boundary.
  return truncateAtWord(translated, PROMO_MAX);
}

// ---------------------------------------------------------------------------
// Multi-field translation (Description, Keywords, What's New, Promotional Text)
// ---------------------------------------------------------------------------

// Apple character limits per localized field.
const FIELD_LIMITS = {
  promotionalText: 170,
  description: 4000,
  keywords: 100,
  whatsNew: 4000,
  supportUrl: 255, // URL field — validated only; never translated.
  privacyPolicyUrl: 255, // App Info URL — validated only; never translated.
};

// Human labels to guide the translator per field.
const FIELD_LABELS = {
  promotionalText: "Promotional Text (short marketing line)",
  description: "App Store Description",
  keywords: "Keywords — a comma-separated list of search terms",
  whatsNew: "What's New in This Version (release notes)",
};

/**
 * Trim a comma-separated keyword string to `maxLen`, cutting at the last comma
 * so we never leave a half keyword.
 */
function truncateKeywords(text, maxLen = FIELD_LIMITS.keywords) {
  if (typeof text !== "string" || text.length <= maxLen) {
    return text;
  }
  const slice = text.slice(0, maxLen);
  const lastComma = slice.lastIndexOf(",");
  const cut = lastComma > 0 ? slice.slice(0, lastComma) : slice;
  return cut.replace(/[\s,]+$/, "");
}

/** Trim one field to its Apple limit using the right strategy. */
function trimField(field, value) {
  if (typeof value !== "string") return "";
  const v = value.trim();
  if (field === "keywords") return truncateKeywords(v, FIELD_LIMITS.keywords);
  return truncateAtWord(v, FIELD_LIMITS[field] || v.length);
}

/**
 * Translate several metadata fields into `targetLocale` in ONE OpenAI call.
 * Returns an object with the SAME keys, each translated and trimmed to its
 * Apple limit. Uses structured outputs so the reply is guaranteed JSON.
 *
 * @param {object} fields - subset of { promotionalText, description, keywords, whatsNew }.
 * @param {string} targetLocale - e.g. "fr-FR".
 */
async function translateFields(fields, targetLocale) {
  const keys = Object.keys(fields).filter(
    (k) => typeof fields[k] === "string" && fields[k].trim().length > 0
  );
  if (keys.length === 0) return {};

  const language = localeToLanguage(targetLocale);

  // Force a JSON reply with exactly the requested keys (structured outputs).
  const properties = {};
  keys.forEach((k) => {
    properties[k] = { type: "string" };
  });
  const schema = {
    type: "object",
    properties,
    required: keys,
    additionalProperties: false,
  };

  const guide = keys.map((k) => `- "${k}": ${FIELD_LABELS[k] || k}`).join("\n");

  const completion = await getClient().chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are a professional App Store localization translator. You receive a " +
          "JSON object of app metadata fields and translate each field's value into " +
          "the target language, preserving meaning, tone, and marketing intent. For " +
          "the 'keywords' field, it is a comma-separated list of search terms — " +
          "translate each term, keep them comma-separated, no duplicates and no extra " +
          "words. If a value is already in the target language, return it unchanged. " +
          "Return ONLY a JSON object with exactly the same keys.",
      },
      {
        role: "user",
        content:
          `Target language: ${language}\n\n` +
          `Field meanings:\n${guide}\n\n` +
          `Fields to translate:\n${JSON.stringify(fields, null, 2)}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "app_store_localization",
        strict: true,
        schema,
      },
    },
  });

  const message = completion.choices[0].message;
  if (message.refusal) {
    throw new Error(`Translation refused: ${message.refusal}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(message.content || "{}");
  } catch (e) {
    throw new Error("Translation returned invalid JSON.");
  }

  const result = {};
  for (const k of keys) {
    result[k] = trimField(k, parsed[k]);
  }
  return result;
}

module.exports = {
  translateText,
  translateFields,
  localeToLanguage,
  truncateAtWord,
  truncateKeywords,
  FIELD_LIMITS,
};
