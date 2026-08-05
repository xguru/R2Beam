const keySets = new Map();
const KEY_CACHE_TTL_MS = 5 * 60 * 1000;

export class AccessDeniedError extends Error {}

function denied(message) {
  return new AccessDeniedError(message);
}

function decodeBase64Url(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJson(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

export function normalizeTeamDomain(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) throw new Error("TEAM_DOMAIN 설정이 필요합니다.");
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withProtocol);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".cloudflareaccess.com") || url.pathname !== "/") {
    throw new Error("TEAM_DOMAIN은 https://<team>.cloudflareaccess.com 형식이어야 합니다.");
  }
  return url.origin;
}

function expectedAudiences(value) {
  const audiences = String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!audiences.length) throw new Error("POLICY_AUD 설정이 필요합니다.");
  return audiences;
}

function tokenHasAudience(payload, audiences) {
  const values = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  return audiences.some((audience) => values.includes(audience));
}

async function fetchKeySet(teamDomain, fetchImpl, force = false) {
  const cached = keySets.get(teamDomain);
  if (!force && cached && Date.now() - cached.fetchedAt < KEY_CACHE_TTL_MS) return cached.keys;
  const response = await fetchImpl(`${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error("Cloudflare Access 공개 키를 가져오지 못했습니다.");
  const body = await response.json();
  if (!Array.isArray(body.keys)) throw new Error("Cloudflare Access 공개 키 응답이 올바르지 않습니다.");
  keySets.set(teamDomain, { keys: body.keys, fetchedAt: Date.now() });
  return body.keys;
}

async function signingKey(teamDomain, kid, fetchImpl) {
  let keys = await fetchKeySet(teamDomain, fetchImpl);
  let jwk = keys.find((candidate) => candidate.kid === kid);
  if (!jwk) {
    keys = await fetchKeySet(teamDomain, fetchImpl, true);
    jwk = keys.find((candidate) => candidate.kid === kid);
  }
  if (!jwk) throw new Error("Cloudflare Access 서명 키를 찾지 못했습니다.");
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
}

export async function verifyAccessJwt(token, config, options = {}) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw denied("Cloudflare Access JWT가 없습니다.");
  let header;
  let payload;
  try {
    header = decodeJson(parts[0]);
    payload = decodeJson(parts[1]);
  } catch {
    throw denied("Cloudflare Access JWT 형식이 올바르지 않습니다.");
  }
  if (header.alg !== "RS256" || !header.kid) throw denied("지원하지 않는 Access JWT 서명입니다.");

  const teamDomain = normalizeTeamDomain(config.teamDomain);
  const audiences = expectedAudiences(config.policyAud);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (payload.iss !== teamDomain) throw denied("Access JWT 발급자가 올바르지 않습니다.");
  if (!tokenHasAudience(payload, audiences)) throw denied("Access JWT audience가 올바르지 않습니다.");
  if (!Number.isFinite(payload.exp) || payload.exp <= now) throw denied("Access JWT가 만료되었습니다.");
  if (Number.isFinite(payload.nbf) && payload.nbf > now + 60) throw denied("Access JWT가 아직 유효하지 않습니다.");

  const key = await signingKey(teamDomain, header.kid, options.fetchImpl || fetch);
  const verified = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    decodeBase64Url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!verified) throw denied("Access JWT 서명이 올바르지 않습니다.");
  return payload;
}

export function localAuthEnabled(env, request) {
  if (String(env.DEV_AUTH_BYPASS || "").toLowerCase() !== "true") return false;
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export async function accessIdentity(env, request) {
  if (localAuthEnabled(env, request)) return { email: "Local developer", local: true };
  const payload = await verifyAccessJwt(request.headers.get("cf-access-jwt-assertion"), {
    teamDomain: env.TEAM_DOMAIN,
    policyAud: env.POLICY_AUD
  });
  return { email: payload.email || payload.sub || "Cloudflare Access user", sub: payload.sub, local: false };
}
