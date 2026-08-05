const API_BASE = "https://api.cloudflare.com/client/v4";
const ASSET_PREFIX = "_r2beam/assets";

export class CloudflareError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

export function client(accessToken, fetchImpl = fetch) {
  return async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${accessToken}`);
    headers.set("Accept", "application/json");
    const response = await fetchImpl(`${API_BASE}${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body
    });
    const data = await response.json().catch(() => null);
    if (options.allowMissing && response.status === 404) return null;
    if (options.allowNotEnabled && data?.errors?.some((item) => item.message?.includes("access.api.error.not_enabled"))) return null;
    if (!response.ok || !data?.success) {
      const message = data?.errors?.map((item) => `${item.code ? `${item.code}: ` : ""}${item.message || ""}`).filter(Boolean).join(" · ");
      throw new CloudflareError(`${path}: ${message || `Cloudflare API 요청이 실패했습니다. (${response.status})`}`, response.status === 401 || response.status === 403 ? 403 : 502);
    }
    return data.result;
  };
}

function jsonBody(value) {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) };
}

async function ensureBucket(api, accountId, bucketName) {
  const existing = await api(`/accounts/${accountId}/r2/buckets/${bucketName}`, { allowMissing: true });
  if (existing) return "reused";
  await api(`/accounts/${accountId}/r2/buckets`, { method: "POST", ...jsonBody({ name: bucketName }) });
  return "created";
}

async function uploadReleaseAssets(api, accountId, bucketName, release, releases) {
  for (const asset of release.assets) {
    const response = await releases.fetch(new Request(`https://release.invalid${asset.source}`));
    if (!response.ok || !response.body) throw new CloudflareError(`릴리스 자산을 읽지 못했습니다: ${asset.path}`, 500);
    const bytes = await response.arrayBuffer();
    const key = `${ASSET_PREFIX}${asset.path}`;
    await api(`/accounts/${accountId}/r2/buckets/${bucketName}/objects/${key}`, {
      method: "PUT",
      headers: { "content-type": asset.contentType, "content-length": String(bytes.byteLength) },
      body: bytes
    });
  }
}

async function uploadWorker(api, accountId, workerName, bucketName, bundle) {
  const form = new FormData();
  form.set("metadata", new Blob([JSON.stringify({
    main_module: "worker.js",
    compatibility_date: "2026-08-05",
    bindings: [
      { type: "r2_bucket", name: "MEDIA", bucket_name: bucketName }
    ],
    observability: { enabled: true }
  })], { type: "application/json" }), "metadata.json");
  form.set("worker.js", new Blob([bundle], { type: "application/javascript+module" }), "worker.js");
  await api(`/accounts/${accountId}/workers/scripts/${workerName}`, { method: "PUT", body: form });
  await api(`/accounts/${accountId}/workers/scripts/${workerName}/subdomain`, {
    method: "POST",
    ...jsonBody({ enabled: true, previews_enabled: false })
  });
}

function policy(name, decision, email) {
  return { name, decision, precedence: 1, include: decision === "bypass" ? [{ everyone: {} }] : [{ email: { email } }] };
}

function application(name, domain, accessPolicy) {
  return { name, domain, type: "self_hosted", session_duration: "720h", app_launcher_visible: false, policies: [accessPolicy] };
}

async function ensurePolicy(api, accountId, app, desired) {
  const policies = await api(`/accounts/${accountId}/access/apps/${app.id}/policies`);
  const existing = policies.find((item) => item.name === desired.name);
  const path = `/accounts/${accountId}/access/apps/${app.id}/policies${existing ? `/${existing.id}` : ""}`;
  await api(path, { method: existing ? "PUT" : "POST", ...jsonBody(desired) });
}

async function ensureApp(api, accountId, apps, desired) {
  const existing = apps.find((item) => item.type === "self_hosted" && item.domain === desired.domain);
  if (!existing) {
    const created = await api(`/accounts/${accountId}/access/apps`, { method: "POST", ...jsonBody(desired) });
    apps.push(created);
    return created;
  }
  await ensurePolicy(api, accountId, existing, desired.policies[0]);
  return existing;
}

async function putSecret(api, accountId, workerName, name, text) {
  await api(`/accounts/${accountId}/workers/scripts/${workerName}/secrets`, {
    method: "PUT",
    ...jsonBody({ name, text, type: "secret_text" })
  });
}

async function ensureLoginMethod(api, accountId) {
  const providers = await api(`/accounts/${accountId}/access/identity_providers`);
  if (providers.length > 0) return "reused";
  await api(`/accounts/${accountId}/access/identity_providers`, {
    method: "POST",
    ...jsonBody({
      name: "Cloudflare",
      type: "cloudflare",
      config: { restrict_to_account_members: true }
    })
  });
  return "created";
}

async function ensureCustomDomain(api, accountId, workerName, customDomain) {
  if (!customDomain) return "skipped";
  const domains = await api(`/accounts/${accountId}/workers/domains`);
  const existing = domains.find((item) => item.hostname === customDomain.hostname);
  if (existing) {
    if (existing.service !== workerName) throw new CloudflareError(`${customDomain.hostname}은 이미 다른 Worker에 연결되어 있습니다.`, 409);
    return "reused";
  }
  await api(`/accounts/${accountId}/workers/domains`, {
    method: "PUT",
    ...jsonBody({
      hostname: customDomain.hostname,
      service: workerName,
      zone_id: customDomain.zoneId,
      zone_name: customDomain.zoneName
    })
  });
  return "created";
}

async function configureAccess(api, accountId, workerName, ownerEmail, customDomain) {
  const workerSubdomain = await api(`/accounts/${accountId}/workers/subdomain`);
  const hostname = `${workerName}.${workerSubdomain.subdomain}.workers.dev`;
  let organization = await api(`/accounts/${accountId}/access/organizations`, { allowMissing: true, allowNotEnabled: true });
  const apps = organization ? await api(`/accounts/${accountId}/access/apps?per_page=100`) : [];
  if (!organization) {
    const slug = String(workerSubdomain.subdomain).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "my";
    const teamName = `${slug.slice(0, 24)}-r2beam-${accountId.slice(0, 6)}`;
    organization = await api(`/accounts/${accountId}/access/organizations`, {
      method: "POST",
      ...jsonBody({ name: "R2Beam", auth_domain: `${teamName}.cloudflareaccess.com`, session_duration: "720h" })
    });
  }
  await ensureLoginMethod(api, accountId);
  const admin = await ensureApp(api, accountId, apps, application("R2Beam", hostname, policy("R2Beam owner", "allow", ownerEmail)));
  await ensureApp(api, accountId, apps, application("R2Beam public media", `${hostname}/media/*`, policy("R2Beam public media", "bypass")));
  if (!admin.aud) throw new CloudflareError("Access Audience 값을 확인하지 못했습니다.");
  const audiences = [admin.aud];
  if (customDomain) {
    const customAdmin = await ensureApp(api, accountId, apps, application(`R2Beam (${customDomain.hostname})`, customDomain.hostname, policy("R2Beam owner", "allow", ownerEmail)));
    await ensureApp(api, accountId, apps, application(`R2Beam public media (${customDomain.hostname})`, `${customDomain.hostname}/media/*`, policy("R2Beam public media", "bypass")));
    if (!customAdmin.aud) throw new CloudflareError("커스텀 도메인의 Access Audience 값을 확인하지 못했습니다.");
    audiences.push(customAdmin.aud);
  }
  await putSecret(api, accountId, workerName, "TEAM_DOMAIN", `https://${organization.auth_domain}`);
  await putSecret(api, accountId, workerName, "POLICY_AUD", audiences.join(","));
  return `https://${customDomain?.hostname || hostname}`;
}

export async function waitForAccessProtection(url, fetchImpl = fetch, sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await fetchImpl(url, { redirect: "manual" }).catch(() => null);
    const location = response?.headers.get("location") || "";
    const challenge = response?.headers.get("www-authenticate") || "";
    if (location.includes("cloudflareaccess.com/cdn-cgi/access/login/") || challenge.includes("Cloudflare-Access")) return true;
    if (attempt < 11) await sleep(1000);
  }
  return false;
}

export async function installR2Beam({ accessToken, accountId, ownerEmail, workerName, bucketName, customDomain, releases, fetchImpl = fetch, sleep }) {
  const api = client(accessToken, fetchImpl);
  const releaseResponse = await releases.fetch(new Request("https://release.invalid/manifest.json"));
  const bundleResponse = await releases.fetch(new Request("https://release.invalid/r2beam-worker.js"));
  if (!releaseResponse.ok || !bundleResponse.ok) throw new CloudflareError("R2Beam 릴리스를 읽지 못했습니다.", 500);
  const release = await releaseResponse.json();
  const bundle = await bundleResponse.arrayBuffer();
  const step = async (label, action) => {
    try {
      return await action();
    } catch (error) {
      throw new CloudflareError(`${label}: ${error.message || error}`, error.status || 502);
    }
  };
  const bucket = await step("R2 버킷 준비", () => ensureBucket(api, accountId, bucketName));
  await step("릴리스 파일 업로드", () => uploadReleaseAssets(api, accountId, bucketName, release, releases));
  await step("Worker 배포", () => uploadWorker(api, accountId, workerName, bucketName, bundle));
  await step("커스텀 도메인 설정", () => ensureCustomDomain(api, accountId, workerName, customDomain));
  const url = await step("Access 설정", () => configureAccess(api, accountId, workerName, ownerEmail, customDomain));
  const accessReady = await waitForAccessProtection(url, fetchImpl, sleep);
  return { url, version: release.version, bucket, customDomain: customDomain?.hostname || null, accessReady };
}
