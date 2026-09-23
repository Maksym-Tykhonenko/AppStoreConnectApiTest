// ---------------------------------------------------------------------------
// proxy.js
// ---------------------------------------------------------------------------
// Optional outbound proxy for ALL requests the backend makes (App Store
// Connect API + OpenAI). Set PROXY_URL in .env to route through it, so Apple /
// OpenAI see the proxy's IP instead of this machine's.
//
//   PROXY_URL=http://user:pass@host:port
//   PROXY_URL=socks5://host:1080
//
// When PROXY_URL is empty, requests go out normally (no proxy).
// ---------------------------------------------------------------------------

const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");

// Does "x:y" look like host:port (a numeric port after a single colon)?
function isHostPort(s) {
  return /^[^:@]+:\d{1,5}$/.test(s);
}

// Build http://user:pass@host:port from separate pieces (credentials encoded).
function buildHttp(host, port, user, pass) {
  let auth = "";
  if (user) {
    auth = pass
      ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`
      : `${encodeURIComponent(user)}@`;
  }
  return `http://${auth}${host}:${port}`;
}

// Accept many shapes and normalize to a URL the proxy agents understand:
//   * a real URL             http://user:pass@host:port, socks5://host:1080
//   * host:port              -> http://host:port
//   * host:port:user:pass    -> http://user:pass@host:port
//   * user:pass@host:port    -> http://user:pass@host:port   (missing scheme)
//   * host:port@user:pass    -> http://user:pass@host:port   (scrambled order)
// For the "@" forms we decide which side is host:port by looking for the numeric
// port, so a swapped order still resolves correctly. Missing scheme defaults to
// http:// (works for our proxy on both HTTP-CONNECT and SOCKS ports).
function normalizeProxyUrl(raw) {
  const url = (raw || "").trim();
  if (!url) return null;
  if (/:\/\//.test(url)) return url; // already a full URL (scheme preserved)

  if (url.includes("@")) {
    const at = url.lastIndexOf("@");
    const left = url.slice(0, at);
    const right = url.slice(at + 1);
    // Prefer the standard position (host:port on the right); fall back to the
    // scrambled order (host:port on the left).
    let hostPort;
    let userInfo;
    if (isHostPort(right)) {
      hostPort = right;
      userInfo = left;
    } else if (isHostPort(left)) {
      hostPort = left;
      userInfo = right;
    } else {
      return `http://${url}`; // can't tell — let the agent surface a clear error
    }
    const [host, port] = hostPort.split(":");
    const ci = userInfo.indexOf(":");
    const user = ci >= 0 ? userInfo.slice(0, ci) : userInfo;
    const pass = ci >= 0 ? userInfo.slice(ci + 1) : "";
    return buildHttp(host, port, user, pass);
  }

  const parts = url.split(":");
  if (parts.length === 2) {
    return `http://${parts[0]}:${parts[1]}`;
  }
  if (parts.length === 4) {
    const [host, port, user, pass] = parts;
    return buildHttp(host, port, user, pass);
  }
  return `http://${url}`; // unknown shape — prefix a scheme so the URL parses
}

// One agent per distinct proxy url (targets can each have their own proxy).
const agents = new Map(); // normalized url -> agent

// Build/reuse an agent for a given proxy url (falls back to .env PROXY_URL when
// `proxyUrl` is undefined). Returns null when no proxy is configured.
function getAgent(proxyUrl) {
  const raw = proxyUrl !== undefined ? proxyUrl : process.env.PROXY_URL;
  const url = normalizeProxyUrl(raw);
  if (!url) return null;
  if (!agents.has(url)) {
    agents.set(
      url,
      /^socks/i.test(url) ? new SocksProxyAgent(url) : new HttpsProxyAgent(url)
    );
  }
  return agents.get(url);
}

// Config to spread into an axios request/instance. `proxy: false` tells axios
// to use our agent instead of its own (limited) proxy handling.
function axiosProxyConfig(proxyUrl) {
  const a = getAgent(proxyUrl);
  return a ? { httpAgent: a, httpsAgent: a, proxy: false } : {};
}

// Human-readable proxy target with credentials masked (for logs).
function describe(proxyUrl) {
  const raw = proxyUrl !== undefined ? proxyUrl : process.env.PROXY_URL;
  const url = normalizeProxyUrl(raw);
  if (!url) return null;
  // mask userinfo: scheme://user:pass@host  ->  scheme://***@host
  return url.replace(/\/\/[^/@]+@/, "//***@");
}

module.exports = { getAgent, axiosProxyConfig, describe };
