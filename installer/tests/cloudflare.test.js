import test from "node:test";
import assert from "node:assert/strict";
import { findExistingR2Beam, installR2Beam } from "../src/cloudflare.js";

function envelope(result, status = 200) {
  return new Response(JSON.stringify({ success: status >= 200 && status < 300, result, errors: [] }), { status, headers: { "content-type": "application/json" } });
}

test("installs assets, worker, Access policies, and secrets in the selected account", async () => {
  const calls = [];
  let accessChecks = 0;
  const fetchImpl = async (url, init = {}) => {
    if (url === "https://vault.example.com") {
      accessChecks += 1;
      if (accessChecks === 1) return new Response("Cloudflare Access JWT가 없습니다.", { status: 401 });
      return new Response(null, { status: 302, headers: { location: "https://owner.cloudflareaccess.com/cdn-cgi/access/login/vault.example.com" } });
    }
    const path = new URL(url).pathname.replace("/client/v4", "");
    const method = init.method || "GET";
    calls.push({ path, method, body: init.body, headers: new Headers(init.headers) });
    if (path.endsWith("/r2/buckets/r2beam-media-012345") && method === "GET") return envelope(null, 404);
    if (path.endsWith("/r2/buckets") && method === "POST") return envelope({ name: "r2beam-media-012345" });
    if (path.includes("/objects/") && method === "PUT") return envelope({ key: path.split("/objects/")[1] });
    if (path.endsWith("/workers/scripts/r2beam-012345") && method === "PUT") return envelope({ id: "r2beam-012345" });
    if (path.endsWith("/workers/scripts/r2beam-012345/subdomain") && method === "POST") return envelope({ enabled: true });
    if (path.endsWith("/workers/subdomain")) return envelope({ subdomain: "owner" });
    if (path.endsWith("/workers/domains") && method === "GET") return envelope([]);
    if (path.endsWith("/workers/domains") && method === "PUT") return envelope({ id: "domain", ...JSON.parse(init.body) });
    if (path.endsWith("/access/organizations") && method === "GET") {
      return new Response(JSON.stringify({ success: false, errors: [{ message: "access.api.error.not_enabled: Access is not enabled." }] }), {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    }
    if (path.endsWith("/access/organizations") && method === "POST") return envelope({ auth_domain: "owner.cloudflareaccess.com" });
    if (path.endsWith("/access/identity_providers") && method === "GET") return envelope([]);
    if (path.endsWith("/access/identity_providers") && method === "POST") return envelope({ id: "cloudflare-idp", ...JSON.parse(init.body) });
    if (path.endsWith("/access/apps") && method === "GET") return envelope([]);
    if (path.endsWith("/access/apps") && method === "POST") {
      const body = JSON.parse(init.body);
      const isMedia = body.domain.endsWith("/media/*");
      const isCustom = body.domain.startsWith("vault.example.com");
      return envelope({ id: `${isCustom ? "custom-" : ""}${isMedia ? "media" : "admin"}`, aud: isMedia ? "media-aud" : isCustom ? "custom-admin-aud" : "admin-aud", ...body });
    }
    if (path.endsWith("/secrets") && method === "PUT") return envelope({});
    throw new Error(`Unexpected ${method} ${path}`);
  };
  const releases = {
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/manifest.json") return Response.json({ version: "0.1.1", assets: [{ path: "/index.html", source: "/files/index.html", contentType: "text/html" }] });
      if (path === "/r2beam-worker.js") return new Response("export default { fetch() {} }");
      if (path === "/files/index.html") return new Response("<h1>R2Beam</h1>");
      return new Response(null, { status: 404 });
    }
  };

  const result = await installR2Beam({
    accessToken: "oauth-token",
    accountId: "0123456789abcdef0123456789abcdef",
    ownerEmail: "owner@example.com",
    workerName: "r2beam-012345",
    bucketName: "r2beam-media-012345",
    customDomain: { hostname: "vault.example.com", zoneId: "zone-123", zoneName: "example.com" },
    releases,
    fetchImpl,
    sleep: async () => {}
  });

  assert.equal(result.url, "https://vault.example.com");
  assert.equal(result.customDomain, "vault.example.com");
  assert.equal(result.accessReady, true);
  assert.equal(accessChecks, 2);
  assert.equal(calls.filter((call) => call.path.includes("/objects/")).length, 1);
  const assetUpload = calls.find((call) => call.path.includes("/objects/"));
  assert.ok(assetUpload.body instanceof ArrayBuffer);
  assert.equal(assetUpload.headers.get("content-length"), String(assetUpload.body.byteLength));
  const enableSubdomain = calls.find((call) => call.path.endsWith("/subdomain") && call.method === "POST");
  assert.equal(enableSubdomain.headers.get("content-type"), "application/json");
  assert.ok(calls.some((call) => call.path.endsWith("/access/organizations") && call.method === "POST"));
  const loginMethod = calls.find((call) => call.path.endsWith("/access/identity_providers") && call.method === "POST");
  assert.deepEqual(JSON.parse(loginMethod.body), {
    name: "Cloudflare",
    type: "cloudflare",
    config: { restrict_to_account_members: true }
  });
  assert.equal(loginMethod.headers.get("content-type"), "application/json");
  const domain = calls.find((call) => call.path.endsWith("/workers/domains") && call.method === "PUT");
  assert.deepEqual(JSON.parse(domain.body), {
    hostname: "vault.example.com",
    service: "r2beam-012345",
    zone_id: "zone-123",
    zone_name: "example.com"
  });
  const upload = calls.find((call) => call.path.endsWith("/workers/scripts/r2beam-012345") && call.method === "PUT");
  assert.ok(upload.body instanceof FormData);
  const metadata = JSON.parse(await upload.body.get("metadata").text());
  assert.deepEqual(metadata.bindings, [
    { type: "r2_bucket", name: "MEDIA", bucket_name: "r2beam-media-012345" },
    { type: "plain_text", name: "R2BEAM_VERSION", text: "0.1.1" }
  ]);
  const secretBodies = calls.filter((call) => call.path.endsWith("/secrets")).map((call) => JSON.parse(call.body));
  assert.deepEqual(secretBodies.map((item) => item.name), ["TEAM_DOMAIN", "POLICY_AUD"]);
  assert.equal(secretBodies.find((item) => item.name === "POLICY_AUD").text, "admin-aud,custom-admin-aud");
});

test("reuses an existing Access login method", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    if (url === "https://r2beam-012345.owner.workers.dev") {
      return new Response(null, { status: 302, headers: { "www-authenticate": "Cloudflare-Access" } });
    }
    const path = new URL(url).pathname.replace("/client/v4", "");
    const method = init.method || "GET";
    calls.push({ path, method });
    if (path.endsWith("/r2/buckets/r2beam-media-012345") && method === "GET") return envelope({ name: "r2beam-media-012345" });
    if (path.includes("/objects/") && method === "PUT") return envelope({});
    if (path.endsWith("/workers/scripts/r2beam-012345") && method === "PUT") return envelope({});
    if (path.endsWith("/workers/scripts/r2beam-012345/subdomain") && method === "POST") return envelope({});
    if (path.endsWith("/workers/subdomain")) return envelope({ subdomain: "owner" });
    if (path.endsWith("/access/organizations")) return envelope({ auth_domain: "owner.cloudflareaccess.com" });
    if (path.endsWith("/access/apps") && method === "GET") return envelope([]);
    if (path.endsWith("/access/identity_providers") && method === "GET") return envelope([{ id: "otp", type: "onetimepin" }]);
    if (path.endsWith("/access/apps") && method === "POST") {
      const body = JSON.parse(init.body);
      return envelope({ id: body.name.includes("public") ? "media" : "admin", aud: body.name === "R2Beam" ? "admin-aud" : "media-aud", ...body });
    }
    if (path.endsWith("/secrets") && method === "PUT") return envelope({});
    throw new Error(`Unexpected ${method} ${path}`);
  };
  const releases = {
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/manifest.json") return Response.json({ version: "0.1.1", assets: [] });
      if (path === "/r2beam-worker.js") return new Response("export default { fetch() {} }");
      return new Response(null, { status: 404 });
    }
  };

  await installR2Beam({
    accessToken: "oauth-token",
    accountId: "0123456789abcdef0123456789abcdef",
    ownerEmail: "owner@example.com",
    workerName: "r2beam-012345",
    bucketName: "r2beam-media-012345",
    releases,
    fetchImpl
  });

  assert.equal(calls.filter((call) => call.path.endsWith("/access/identity_providers") && call.method === "POST").length, 0);
});

test("finds an existing R2Beam worker, bucket, version, and custom domain", async () => {
  const accountId = "0123456789abcdef0123456789abcdef";
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname.replace("/client/v4", "");
    if (path.endsWith("/workers/scripts")) {
      return envelope([{ id: "another-worker" }, { id: "r2beam-012345" }]);
    }
    if (path.endsWith("/workers/domains")) {
      return envelope([{ service: "r2beam-012345", hostname: "vault.example.com" }]);
    }
    if (path.endsWith("/workers/scripts/r2beam-012345/settings")) {
      return envelope({ bindings: [
        { type: "r2_bucket", name: "MEDIA", bucket_name: "r2beam-media-012345" },
        { type: "plain_text", name: "R2BEAM_VERSION", text: "0.1.0" },
        { type: "secret_text", name: "TEAM_DOMAIN" },
        { type: "secret_text", name: "POLICY_AUD" }
      ] });
    }
    throw new Error(`Unexpected GET ${path}`);
  };

  assert.deepEqual(await findExistingR2Beam({ accessToken: "oauth-token", accountId, fetchImpl }), {
    workerName: "r2beam-012345",
    bucketName: "r2beam-media-012345",
    customHostname: "vault.example.com",
    version: "0.1.0"
  });
});
