import { CloudflareError, client, findExistingR2Beam, installR2Beam } from "./cloudflare.js";

const AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";
const TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
const REVOKE_URL = "https://dash.cloudflare.com/oauth2/revoke";
const SESSION_COOKIE = "r2beam_install";
const R2_OVERVIEW_URL = "https://dash.cloudflare.com/?to=%2F%3Aaccount%2Fr2%2Foverview";
const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function randomToken(bytes = 24) {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function challenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function page(content, status = 200) {
  return new Response(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>R2Beam 설치</title><style>:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;--bg:#0a0c0f;--panel:#12151a;--line:#2a3038;--muted:#98a1ae;--accent:#d7ff64}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 10% 0%,#20281b 0,transparent 35%),var(--bg);color:#f6f8fa}main{width:min(900px,calc(100% - 32px));padding:52px 0}.brand{color:var(--accent);font-size:12px;font-weight:850;letter-spacing:.15em}h1{margin:42px 0 14px;font-size:clamp(34px,7vw,54px);line-height:1.05;letter-spacing:-.055em}.hero-title{font-size:clamp(22px,6vw,46px);white-space:nowrap}p{color:var(--muted);line-height:1.7}@media(min-width:940px){.lead{white-space:nowrap}}.card{margin-top:34px;padding:24px;border:1px solid var(--line);border-radius:18px;background:var(--panel)}.card-title{margin:0 0 16px;color:#f6f8fa;font-size:14px;font-weight:800}.features{display:grid;gap:10px;margin:0 0 20px;padding:0;list-style:none;color:var(--muted);font-size:14px;line-height:1.5}.features li{display:flex;gap:9px}.features li::before{content:'✓';color:var(--accent);font-weight:900}.flow{margin:0;font-size:13px}.r2-note,.upgrade-note{margin:18px 0 0;padding:14px 16px;border:1px solid #3a4328;border-radius:11px;background:#151a11;font-size:13px}.r2-note strong,.upgrade-note strong{color:#f6f8fa}.upgrade-note{border-color:#53652d;background:#18200f}.text-link{color:var(--accent);font-weight:750}label{display:grid;gap:7px;margin:14px 0;font-size:13px;font-weight:750}label small{color:var(--muted);font-size:11px;font-weight:500;line-height:1.5}select,input{width:100%;padding:13px;border:1px solid #38404a;border-radius:10px;background:#0c0f12;color:white;font:inherit}.account-picker{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:end;margin-top:28px}.account-picker label{margin:0}.account-picker button{width:auto;margin:0}.existing-values{display:grid;gap:10px;margin:18px 0;padding:15px;border:1px solid var(--line);border-radius:11px}.existing-values div{display:grid;grid-template-columns:130px 1fr;gap:12px;font-size:13px}.existing-values dt{color:var(--muted)}.existing-values dd{margin:0;overflow-wrap:anywhere}button,.button{display:inline-flex;justify-content:center;width:100%;margin-top:14px;padding:14px;border:0;border-radius:11px;background:var(--accent);color:#10130a;text-decoration:none;font-weight:800;cursor:pointer}.button.secondary{border:1px solid #46505c;background:#1b2026;color:#f6f8fa}.retry-form{margin:0}.meta{font-size:12px}.repo{margin:26px 0 0;text-align:center;font-size:12px}.repo a{color:var(--muted);text-decoration:none}.repo a:hover{color:var(--accent)}@media(max-width:600px){.account-picker{grid-template-columns:1fr}.account-picker button{width:100%}.existing-values div{grid-template-columns:1fr;gap:3px}}</style></head><body><main><p class="brand">◆ R2BEAM</p>${content}</main></body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" } });
}

export function isR2NotEnabledError(error) {
  return Number(error?.code) === 10042 || /Please enable R2 through the Cloudflare Dashboard/i.test(String(error?.message || ""));
}

function r2ActivationRequiredPage({ accountId, workerName, bucketName, customHostname, upgrading = false }) {
  const hidden = [
    ["accountId", accountId],
    ["workerName", workerName],
    ["bucketName", bucketName],
    ["customHostname", customHostname || ""],
    ["operation", upgrading ? "upgrade" : "install"]
  ].map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`).join("");
  return page(`<h1>R2를 먼저<br>활성화해 주세요.</h1><p>선택한 Cloudflare 계정에서 R2가 아직 활성화되지 않았습니다.</p><div class="card"><p class="card-title">Cloudflare Dashboard에서 R2 구독을 활성화한 뒤 이 화면으로 돌아오세요.</p><p>R2에는 무료 월간 사용량이 포함되지만, 새 계정은 최초 한 번 구독 확인 절차를 완료해야 합니다. 설치 세션이 유지되는 동안 OAuth를 다시 진행할 필요는 없습니다.</p><a class="button" href="${R2_OVERVIEW_URL}" target="_blank" rel="noopener noreferrer">Cloudflare에서 R2 활성화</a><form class="retry-form" method="post" action="/install">${hidden}<button class="button secondary" type="submit">활성화했습니다 · 다시 시도</button></form></div>`, 409);
}

function cookie(request, name) {
  const match = request.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : "";
}

function safeName(value, fallback) {
  const name = String(value || "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name) ? name : fallback;
}

export function customDomainFor(value, accountId, zones = []) {
  const hostname = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  if (!hostname) return null;
  if (!HOSTNAME_PATTERN.test(hostname)) throw new CloudflareError("커스텀 도메인은 vault.example.com과 같은 전체 호스트 이름으로 입력해 주세요.", 400);
  const zone = zones
    .filter((item) => item.accountId === accountId && (hostname === item.name || hostname.endsWith(`.${item.name}`)))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (!zone) throw new CloudflareError("선택한 계정에서 커스텀 도메인에 맞는 활성 Cloudflare Zone을 찾지 못했습니다.", 400);
  return { hostname, zoneId: zone.id, zoneName: zone.name };
}

function requireOAuth(env) {
  if (!env.OAUTH_CLIENT_ID || !env.OAUTH_CLIENT_SECRET) throw new CloudflareError("설치 서비스의 Cloudflare OAuth 설정이 아직 완료되지 않았습니다.", 503);
}

async function startOAuth(env) {
  requireOAuth(env);
  const state = randomToken();
  const verifier = randomToken(48);
  await env.INSTALL_SESSIONS.put(`oauth:${state}`, JSON.stringify({ verifier }), { expirationTtl: 600 });
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({ client_id: env.OAUTH_CLIENT_ID, redirect_uri: env.OAUTH_REDIRECT_URI, response_type: "code", scope: env.OAUTH_SCOPES, state, code_challenge: await challenge(verifier), code_challenge_method: "S256" });
  return Response.redirect(url, 302);
}

async function exchangeCode(env, code, verifier) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: env.OAUTH_REDIRECT_URI,
    client_id: env.OAUTH_CLIENT_ID,
    client_secret: env.OAUTH_CLIENT_SECRET,
    code_verifier: verifier,
  });
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  const response = await fetch(TOKEN_URL, { method: "POST", headers, body });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new CloudflareError(data.error_description || "Cloudflare OAuth 인증에 실패했습니다.", 401);
  return data;
}

async function oauthCallback(env, request) {
  const url = new URL(request.url);
  if (url.searchParams.get("error")) throw new CloudflareError(url.searchParams.get("error_description") || "Cloudflare 권한 승인이 취소되었습니다.", 400);
  const state = url.searchParams.get("state") || "";
  const saved = await env.INSTALL_SESSIONS.get(`oauth:${state}`, "json");
  await env.INSTALL_SESSIONS.delete(`oauth:${state}`);
  if (!saved?.verifier || !url.searchParams.get("code")) throw new CloudflareError("OAuth 요청이 만료되었거나 올바르지 않습니다.", 400);
  const token = await exchangeCode(env, url.searchParams.get("code"), saved.verifier);
  const api = client(token.access_token);
  const [user, accounts, zones] = await Promise.all([api("/user"), api("/accounts?per_page=50"), api("/zones?per_page=50&status=active")]);
  if (!user?.email || !accounts.length) throw new CloudflareError("Cloudflare 사용자 또는 계정 정보를 확인하지 못했습니다.", 403);
  const sessionId = randomToken();
  const availableZones = zones.map((zone) => ({ id: zone.id, name: zone.name, accountId: zone.account?.id })).filter((zone) => zone.id && zone.name && zone.accountId);
  await env.INSTALL_SESSIONS.put(`install:${sessionId}`, JSON.stringify({ accessToken: token.access_token, email: user.email, accounts, zones: availableZones }), { expirationTtl: 1200 });
  return new Response(null, { status: 303, headers: { location: "/configure", "set-cookie": `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=1200` } });
}

async function configuration(env, request) {
  const session = await env.INSTALL_SESSIONS.get(`install:${cookie(request, SESSION_COOKIE)}`, "json");
  if (!session) return new Response(null, { status: 303, headers: { location: "/" } });
  const requestedAccountId = new URL(request.url).searchParams.get("accountId");
  const account = session.accounts.find((item) => item.id === requestedAccountId) || session.accounts[0];
  const accountId = account.id;
  const suffix = accountId.slice(0, 6);
  const existing = await findExistingR2Beam({ accessToken: session.accessToken, accountId });
  const targetVersion = env.R2BEAM_VERSION || "0.1.1";
  const options = session.accounts.map((item) => `<option value="${escapeHtml(item.id)}"${item.id === accountId ? " selected" : ""}>${escapeHtml(item.name)}</option>`).join("");
  const accountPicker = session.accounts.length > 1
    ? `<form class="account-picker" method="get" action="/configure"><label>Cloudflare 계정<select name="accountId">${options}</select></label><button type="submit">계정 확인</button></form>`
    : "";
  const accountZones = (session.zones || []).filter((zone) => zone.accountId === accountId);
  const zoneOptions = accountZones.map((zone) => `<option value="r2beam.${escapeHtml(zone.name)}"></option>`).join("");
  const zoneNames = accountZones.map((zone) => escapeHtml(zone.name)).join(", ");
  const fields = existing
    ? `<input type="hidden" name="workerName" value="${escapeHtml(existing.workerName)}"><input type="hidden" name="bucketName" value="${escapeHtml(existing.bucketName)}"><input type="hidden" name="customHostname" value="${escapeHtml(existing.customHostname)}"><input type="hidden" name="operation" value="upgrade"><p class="upgrade-note"><strong>기존 R2Beam을 찾았습니다.</strong><br>${existing.version ? `v${escapeHtml(existing.version)}에서 ` : ""}v${escapeHtml(targetVersion)}으로 업그레이드합니다. 저장된 미디어와 공개 링크는 그대로 유지됩니다.</p><dl class="existing-values"><div><dt>Worker</dt><dd>${escapeHtml(existing.workerName)}</dd></div><div><dt>R2 버킷</dt><dd>${escapeHtml(existing.bucketName)}</dd></div><div><dt>커스텀 도메인</dt><dd>${escapeHtml(existing.customHostname || "사용하지 않음")}</dd></div></dl>`
    : `<input type="hidden" name="operation" value="install"><label>Worker 이름<input name="workerName" value="r2beam-${suffix}" required></label><label>R2 버킷 이름<input name="bucketName" value="r2beam-media-${suffix}" required></label><label>커스텀 도메인 <small>선택 사항</small><input name="customHostname" list="zone-suggestions" placeholder="vault.example.com"><small>비워두면 workers.dev 주소를 사용합니다.${zoneNames ? ` 사용 가능한 Zone: ${zoneNames}` : " 현재 계정에서 활성 Zone을 찾지 못했습니다."}</small></label><datalist id="zone-suggestions">${zoneOptions}</datalist><p class="r2-note"><strong>새 Cloudflare 계정인가요?</strong> R2는 무료 월간 사용량을 제공하지만 최초 한 번 구독 활성화가 필요합니다. <a class="text-link" href="${R2_OVERVIEW_URL}" target="_blank" rel="noopener noreferrer">R2 활성화하기 ↗</a></p>`;
  const action = existing ? `R2Beam ${escapeHtml(targetVersion)}으로 업그레이드` : "이 계정에 설치";
  return page(`<h1>R2Beam을<br>${existing ? "업그레이드" : "설치"}하세요.</h1><p>미디어는 선택한 Cloudflare 계정의 R2에 저장됩니다.</p>${accountPicker}<form class="card" method="post" action="/install"><input type="hidden" name="accountId" value="${escapeHtml(accountId)}">${fields}<p class="meta">Cloudflare 계정: ${escapeHtml(account.name)} · 관리자: ${escapeHtml(session.email)}</p><button>${action}</button></form>`);
}

async function install(env, request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) throw new CloudflareError("잘못된 요청 출처입니다.", 403);
  const sessionId = cookie(request, SESSION_COOKIE);
  const session = await env.INSTALL_SESSIONS.get(`install:${sessionId}`, "json");
  if (!session) throw new CloudflareError("설치 세션이 만료되었습니다. 다시 시작해 주세요.", 401);
  const form = await request.formData();
  const accountId = String(form.get("accountId") || "");
  if (!session.accounts.some((account) => account.id === accountId)) throw new CloudflareError("설치할 계정을 확인해 주세요.", 400);
  const suffix = accountId.slice(0, 6);
  const workerName = safeName(form.get("workerName"), `r2beam-${suffix}`);
  const bucketName = safeName(form.get("bucketName"), `r2beam-media-${suffix}`);
  const customDomain = customDomainFor(form.get("customHostname"), accountId, session.zones);
  const upgrading = form.get("operation") === "upgrade";
  let result;
  try {
    result = await installR2Beam({ accessToken: session.accessToken, accountId, ownerEmail: session.email, workerName, bucketName, customDomain, releases: env.RELEASES });
  } catch (error) {
    if (isR2NotEnabledError(error)) {
      return r2ActivationRequiredPage({ accountId, workerName, bucketName, customHostname: customDomain?.hostname || "", upgrading });
    }
    throw error;
  }
  await env.INSTALL_SESSIONS.delete(`install:${sessionId}`);
  await fetch(REVOKE_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: session.accessToken, client_id: env.OAUTH_CLIENT_ID }) }).catch(() => {});
  const readiness = result.accessReady
    ? " Cloudflare Access 보호가 활성화된 것을 확인했습니다."
    : " Cloudflare Access 설정이 아직 전파 중일 수 있습니다. 처음 접속했을 때 인증 안내가 나오면 잠시 후 새로고침해 주세요.";
  return page(`<h1>${upgrading ? "업그레이드" : "설치"}가<br>완료되었습니다.</h1><p>R2Beam ${escapeHtml(result.version)}이 ${upgrading ? "업그레이드" : "설치"}되었습니다.${readiness}${result.customDomain ? ` 커스텀 도메인 인증서가 준비되는 데 잠시 걸릴 수 있습니다.` : ""} 처음 접속하면 설치에 사용한 Cloudflare 계정으로 로그인합니다.</p><div class="card"><a class="button" href="${escapeHtml(result.url)}">내 미디어 볼트 열기</a></div>`);
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    try {
      if (request.method === "GET" && path === "/") {
        const action = env.OAUTH_CLIENT_ID && env.OAUTH_CLIENT_SECRET
          ? `<a class="button" href="/oauth/start">Cloudflare로 설치</a>`
          : `<p class="meta">원클릭 설치 서비스를 준비하고 있습니다.</p>`;
        return page(`<h1 class="hero-title">R2Beam - My Media Vault</h1><p class="lead">내 Cloudflare 계정에 개인 미디어 저장소를 설치합니다. 업로드한 파일과 공개 링크는 사용자의 계정에만 남습니다.</p><div class="card"><p class="card-title">설치 도우미는 다음 작업을 자동으로 처리하며, 자신만의 R2Beam 페이지를 구성합니다.</p><ul class="features"><li>미디어를 저장할 전용 R2 버킷과 Worker 생성</li><li>설치한 계정만 들어올 수 있는 Cloudflare Access 로그인 구성</li><li>선택한 커스텀 도메인의 DNS, 인증서와 접근 정책 구성</li><li>파일 업로드 기능과 게시판·블로그에서 바로 쓸 수 있는 공개 미디어 링크 페이지 구성</li><li>트래픽 최소화를 위한 이미지 최적화 및 FFmpeg을 이용한 동영상 인코딩 기능 제공</li></ul><p class="flow">Cloudflare 로그인 → 계정 선택 → 권한 승인 → 설치</p><p class="r2-note"><strong>설치 전 확인:</strong> 새 Cloudflare 계정은 Dashboard에서 R2 구독을 한 번 활성화해야 합니다. 무료 월간 사용량이 포함됩니다. <a class="text-link" href="${R2_OVERVIEW_URL}" target="_blank" rel="noopener noreferrer">R2 활성화하기 ↗</a></p>${action}</div><p class="meta">Account ID나 API Token을 직접 입력할 필요가 없습니다. · <a href="/privacy" style="color:inherit">개인정보 처리방침</a> · <a href="/terms" style="color:inherit">이용 안내</a></p><p class="repo"><a href="https://github.com/xguru/R2Beam" target="_blank" rel="noopener noreferrer">GitHub · xguru/R2Beam ↗</a> · R2Beam v${escapeHtml(env.R2BEAM_VERSION || "dev")}</p>`);
      }
      if (request.method === "GET" && path === "/privacy") return page(`<h1>개인정보<br>처리방침</h1><div class="card"><p>R2Beam Installer는 설치 중 Cloudflare OAuth가 제공한 이메일, 계정·Zone 식별자와 이름, 단기 접근 토큰을 처리합니다.</p><p>이 정보는 사용자가 선택한 계정에 R2Beam을 설치하고 커스텀 도메인을 검증하는 용도로만 사용됩니다. 설치 세션은 최대 20분 후 삭제되며, 설치가 완료되면 접근 토큰을 즉시 폐기합니다.</p><p>업로드한 미디어는 사용자의 Cloudflare R2에 직접 저장되며 R2Beam Installer를 통과하거나 중앙 서버에 저장되지 않습니다.</p></div>`);
      if (request.method === "GET" && path === "/terms") return page(`<h1>이용<br>안내</h1><div class="card"><p>R2Beam은 사용자의 Cloudflare 계정에 설치되는 오픈소스 개인 미디어 저장소입니다.</p><p>Cloudflare 이용 요금, 저장 데이터, 공개 링크와 설치된 리소스의 관리는 사용자에게 귀속됩니다. 설치 후 생성되는 미디어 링크는 링크를 아는 누구나 열 수 있습니다.</p><p>소프트웨어는 MIT 라이선스에 따라 제공됩니다.</p></div>`);
      if (request.method === "GET" && path === "/logo.svg") return new Response(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" rx="48" fill="#0a0c0f"/><path d="M128 38 218 128 128 218 38 128Z" fill="#d7ff64"/><path d="m128 78 50 50-50 50-50-50Z" fill="#0a0c0f"/></svg>`, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
      if (request.method === "GET" && path === "/oauth/start") return await startOAuth(env);
      if (request.method === "GET" && path === "/oauth/callback") return await oauthCallback(env, request);
      if (request.method === "GET" && path === "/configure") return await configuration(env, request);
      if (request.method === "POST" && path === "/install") return await install(env, request);
      return new Response("Not found", { status: 404 });
    } catch (error) {
      if (!(error instanceof CloudflareError)) console.error(error);
      return page(`<h1>설치를<br>진행하지 못했습니다.</h1><p>${escapeHtml(error.message || "알 수 없는 오류가 발생했습니다.")}</p><div class="card"><a class="button" href="/">다시 시작</a></div>`, error.status || 500);
    }
  }
};
