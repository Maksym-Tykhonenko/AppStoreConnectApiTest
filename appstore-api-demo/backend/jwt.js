// ---------------------------------------------------------------------------
// jwt.js
// ---------------------------------------------------------------------------
// Generates the JWT (JSON Web Token) that the App Store Connect API requires
// for authentication, exactly as documented by Apple:
//
//   https://developer.apple.com/documentation/appstoreconnectapi/generating_tokens_for_api_requests
//
// Key facts about Apple's required token:
//   * Algorithm:        ES256 (ECDSA using P-256 and SHA-256).
//   * Header:           { alg: "ES256", kid: <KEY_ID>, typ: "JWT" }
//   * Payload claims:   iss (Issuer ID), iat (issued-at), exp (expiry),
//                       aud ("appstoreconnect-v1").
//   * Max lifetime:     20 minutes. Apple rejects tokens with a longer window.
//
// To avoid re-signing a token on every request (and to avoid using an expired
// one), we cache the token in memory and only regenerate it when it is about
// to expire.
// ---------------------------------------------------------------------------

const fs = require("fs");
const jwt = require("jsonwebtoken");

// Apple's audience value is always this constant.
const AUDIENCE = "appstoreconnect-v1";

// Apple allows a maximum token lifetime of 20 minutes. We use a slightly
// shorter window so the token never expires mid-flight on Apple's side.
const TOKEN_LIFETIME_SECONDS = 19 * 60; // 19 minutes

// We refresh the token a little before the real expiry to be safe.
const REFRESH_MARGIN_SECONDS = 60; // refresh 1 minute early

// In-memory cache PER ACCOUNT (keyed by KEY_ID) so we don't re-sign every call.
const cache = new Map(); // keyId -> { token, expiresAt }

/**
 * Read the private key (.p8) from disk. The key is never hardcoded; it lives
 * on the filesystem and is referenced via the account's privateKeyPath.
 */
function loadPrivateKey(privateKeyPath) {
  if (!privateKeyPath) {
    throw new Error("PRIVATE_KEY_PATH is not set. Check your .env file.");
  }
  try {
    return fs.readFileSync(privateKeyPath, "utf8");
  } catch (err) {
    throw new Error(
      `Could not read private key at "${privateKeyPath}": ${err.message}`
    );
  }
}

/**
 * Sign a brand-new JWT for the App Store Connect API.
 */
function signToken({ issuerId, keyId, privateKey }) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expSeconds = nowSeconds + TOKEN_LIFETIME_SECONDS;

  const payload = {
    iss: issuerId,
    iat: nowSeconds,
    exp: expSeconds,
    aud: AUDIENCE,
  };

  const header = {
    alg: "ES256",
    kid: keyId,
    typ: "JWT",
  };

  // jsonwebtoken signs with the ES256 algorithm using the EC private key.
  const token = jwt.sign(payload, privateKey, {
    algorithm: "ES256",
    header,
  });

  return { token, expSeconds };
}

/**
 * Return a valid token for a given account/target, regenerating it when it has
 * expired (or is about to). Tokens are cached per KEY_ID.
 *
 * @param {object} account - { issuerId, keyId, privateKeyPath }.
 */
function getToken(account) {
  const { issuerId, keyId, privateKeyPath } = account || {};
  if (!issuerId || !keyId) {
    throw new Error("Account is missing issuerId / keyId.");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const cached = cache.get(keyId);

  // Re-use the cached token if it is still comfortably valid.
  if (cached && nowSeconds < cached.expiresAt - REFRESH_MARGIN_SECONDS) {
    return cached.token;
  }

  // Otherwise, sign a fresh one.
  console.log(`[jwt] Generating a new JWT for key ${keyId}...`);
  const privateKey = loadPrivateKey(privateKeyPath);
  const { token, expSeconds } = signToken({ issuerId, keyId, privateKey });
  cache.set(keyId, { token, expiresAt: expSeconds });
  return token;
}

/**
 * Force the next getToken() for this account to mint a fresh token. Used when
 * Apple returns 401 so we can retry once with a new token.
 */
function invalidateToken(account) {
  if (account && account.keyId) cache.delete(account.keyId);
}

module.exports = { getToken, invalidateToken };
