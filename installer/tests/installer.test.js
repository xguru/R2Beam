import test from "node:test";
import assert from "node:assert/strict";
import worker, { customDomainFor, isR2NotEnabledError } from "../src/index.js";
import { CloudflareError } from "../src/cloudflare.js";

test("renders the public installer landing page", async () => {
  const response = await worker.fetch(new Request("https://r2beam.xguru.net/"), { OAUTH_CLIENT_ID: "client", OAUTH_CLIENT_SECRET: "secret", R2BEAM_VERSION: "0.1.3" });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Cloudflare로 설치/);
  assert.match(html, /R2Beam - My Media Vault/);
  assert.doesNotMatch(html, /R2Beam<br>- My Media Vault/);
  assert.match(html, /다음 작업을 자동으로 처리하며, 자신만의 R2Beam 페이지를 구성합니다/);
  assert.match(html, /전용 R2 버킷과 Worker 생성/);
  assert.match(html, /Cloudflare Access 로그인/);
  assert.match(html, /FFmpeg을 이용한 동영상 인코딩 기능/);
  assert.match(html, /API Token을 직접 입력할 필요가 없습니다/);
  assert.match(html, /새 Cloudflare 계정은 Dashboard에서 R2 구독을 한 번 활성화해야 합니다/);
  assert.match(html, /R2 활성화하기/);
  assert.match(html, /https:\/\/github\.com\/xguru\/R2Beam/);
  assert.match(html, /GitHub · xguru\/R2Beam/);
  assert.match(html, /R2Beam v0\.1\.3/);
});

test("publishes the latest and minimum supported versions", async () => {
  const response = await worker.fetch(new Request("https://r2beam.xguru.net/version.json"), {
    R2BEAM_VERSION: "0.2.0",
    R2BEAM_MINIMUM_VERSION: "0.1.3"
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("cache-control"), "public, max-age=300");
  assert.deepEqual(await response.json(), {
    schemaVersion: 1,
    latestVersion: "0.2.0",
    minimumVersion: "0.1.3",
    installerUrl: "https://r2beam.xguru.net/"
  });
});

test("recognizes the Cloudflare R2 subscription error", () => {
  assert.equal(isR2NotEnabledError(new CloudflareError("R2 버킷 준비: Please enable R2 through the Cloudflare Dashboard.", 502, 10042)), true);
  assert.equal(isR2NotEnabledError(new CloudflareError("다른 오류", 502, 99999)), false);
});

test("reuses an existing installation and renders an upgrade notice", async () => {
  const originalFetch = globalThis.fetch;
  const accountId = "86728b78f3db89ba85b7ede8a6ff8567";
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname.replace("/client/v4", "");
    const result = path.endsWith("/workers/scripts")
      ? [{ id: "r2beam-86728b" }]
      : path.endsWith("/workers/domains")
        ? [{ service: "r2beam-86728b", hostname: "r2.example.com" }]
        : path.endsWith("/workers/scripts/r2beam-86728b/settings")
          ? { bindings: [
              { type: "r2_bucket", name: "MEDIA", bucket_name: "r2beam-media-86728b" },
              { type: "plain_text", name: "R2BEAM_VERSION", text: "0.1.2" },
              { type: "secret_text", name: "TEAM_DOMAIN" },
              { type: "secret_text", name: "POLICY_AUD" }
            ] }
          : null;
    if (result === null) throw new Error(`Unexpected GET ${path}`);
    return Response.json({ success: true, result, errors: [] });
  };
  const env = {
    R2BEAM_VERSION: "0.1.3",
    INSTALL_SESSIONS: {
      async get(key) {
        assert.equal(key, "install:session-id");
        return {
          accessToken: "oauth-token",
          email: "owner@example.com",
          accounts: [{ id: accountId, name: "Owner" }],
          zones: [{ id: "zone", name: "example.com", accountId }]
        };
      }
    }
  };
  try {
    const response = await worker.fetch(new Request("https://r2beam.xguru.net/configure", {
      headers: { cookie: "r2beam_install=session-id" }
    }), env);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /기존 R2Beam을 찾았습니다/);
    assert.match(html, /현재 v0\.1\.2입니다\. v0\.1\.3 업그레이드를 진행합니다/);
    assert.match(html, /저장된 미디어와 공개 링크는 그대로 유지됩니다/);
    assert.match(html, /name="workerName" value="r2beam-86728b"/);
    assert.match(html, /name="bucketName" value="r2beam-media-86728b"/);
    assert.match(html, /name="customHostname" value="r2\.example\.com"/);
    assert.match(html, /R2Beam 0\.1\.3 업그레이드/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps the install session and offers an in-place retry when R2 is disabled", async () => {
  const originalFetch = globalThis.fetch;
  const accountId = "86728b78f3db89ba85b7ede8a6ff8567";
  let sessionDeleted = false;
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname.replace("/client/v4", "");
    assert.match(path, /\/r2\/buckets\/r2beam-media-86728b$/);
    return new Response(JSON.stringify({
      success: false,
      result: null,
      errors: [{ code: 10042, message: "Please enable R2 through the Cloudflare Dashboard." }]
    }), { status: 400, headers: { "content-type": "application/json" } });
  };
  const env = {
    OAUTH_CLIENT_ID: "client",
    INSTALL_SESSIONS: {
      async get(key) {
        assert.equal(key, "install:session-id");
        return {
          accessToken: "oauth-token",
          email: "owner@example.com",
          accounts: [{ id: accountId, name: "Owner" }],
          zones: []
        };
      },
      async delete() {
        sessionDeleted = true;
      }
    },
    RELEASES: {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/manifest.json") return Response.json({ version: "0.1.0", assets: [] });
        if (path === "/r2beam-worker.js") return new Response("export default { fetch() {} }");
        return new Response(null, { status: 404 });
      }
    }
  };
  const body = new URLSearchParams({
    accountId,
    workerName: "r2beam-86728b",
    bucketName: "r2beam-media-86728b",
    customHostname: ""
  });
  try {
    const response = await worker.fetch(new Request("https://r2beam.xguru.net/install", {
      method: "POST",
      headers: {
        origin: "https://r2beam.xguru.net",
        cookie: "r2beam_install=session-id",
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    }), env);
    assert.equal(response.status, 409);
    const html = await response.text();
    assert.match(html, /R2를 먼저/);
    assert.match(html, /Cloudflare에서 R2 활성화/);
    assert.match(html, /활성화했습니다 · 다시 시도/);
    assert.match(html, /name="accountId" value="86728b78f3db89ba85b7ede8a6ff8567"/);
    assert.match(html, /name="bucketName" value="r2beam-media-86728b"/);
    assert.match(html, /name="operation" value="install"/);
    assert.doesNotMatch(html, /10042|Please enable R2/);
    assert.equal(sessionDeleted, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not start OAuth before the client is configured", async () => {
  const response = await worker.fetch(new Request("https://r2beam.xguru.net/oauth/start"), {});
  assert.equal(response.status, 503);
  assert.match(await response.text(), /OAuth 설정이 아직 완료되지 않았습니다/);
});

test("matches an optional custom hostname to a Zone in the selected account", () => {
  const zones = [
    { id: "zone-a", name: "example.com", accountId: "account-a" },
    { id: "zone-b", name: "other.com", accountId: "account-b" }
  ];
  assert.deepEqual(customDomainFor("Vault.Example.com.", "account-a", zones), {
    hostname: "vault.example.com",
    zoneId: "zone-a",
    zoneName: "example.com"
  });
  assert.equal(customDomainFor("", "account-a", zones), null);
  assert.throws(() => customDomainFor("vault.other.com", "account-a", zones), /Zone/);
  assert.throws(() => customDomainFor("not a hostname", "account-a", zones), /전체 호스트/);
});
