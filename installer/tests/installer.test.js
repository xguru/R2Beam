import test from "node:test";
import assert from "node:assert/strict";
import worker, { customDomainFor } from "../src/index.js";

test("renders the public installer landing page", async () => {
  const response = await worker.fetch(new Request("https://r2beam.xguru.net/"), { OAUTH_CLIENT_ID: "client", OAUTH_CLIENT_SECRET: "secret" });
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
  assert.match(html, /https:\/\/github\.com\/xguru\/R2Beam/);
  assert.match(html, /GitHub · xguru\/R2Beam/);
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
