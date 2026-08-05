import test from "node:test";
import assert from "node:assert/strict";
import { localAuthEnabled, normalizeTeamDomain, verifyAccessJwt } from "../src/access.js";

function base64url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Buffer.from(bytes).toString("base64url");
}

async function fixtureJwt(overrides = {}) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const kid = crypto.randomUUID();
  const header = base64url(JSON.stringify({ alg: "RS256", kid }));
  const payload = base64url(JSON.stringify({
    iss: "https://team.cloudflareaccess.com",
    aud: ["r2beam-audience"],
    email: "owner@example.com",
    sub: "owner-id",
    exp: 2_000_000_000,
    ...overrides
  }));
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input));
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { token: `${input}.${base64url(new Uint8Array(signature))}`, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

test("normalizes and restricts Access team domains", () => {
  assert.equal(normalizeTeamDomain("team.cloudflareaccess.com/"), "https://team.cloudflareaccess.com");
  assert.throws(() => normalizeTeamDomain("https://example.com"), /TEAM_DOMAIN/);
});

test("verifies an Access JWT signature, issuer, audience, and expiration", async () => {
  const fixture = await fixtureJwt();
  const payload = await verifyAccessJwt(fixture.token, {
    teamDomain: "https://team.cloudflareaccess.com",
    policyAud: "r2beam-audience"
  }, {
    now: 1_900_000_000,
    fetchImpl: async () => new Response(JSON.stringify({ keys: [fixture.jwk] }))
  });
  assert.equal(payload.email, "owner@example.com");
});

test("accepts an Access JWT for any configured hostname audience", async () => {
  const fixture = await fixtureJwt({ aud: ["custom-domain-audience"] });
  const payload = await verifyAccessJwt(fixture.token, {
    teamDomain: "https://team.cloudflareaccess.com",
    policyAud: "workers-dev-audience,custom-domain-audience"
  }, {
    now: 1_900_000_000,
    fetchImpl: async () => new Response(JSON.stringify({ keys: [fixture.jwk] }))
  });
  assert.equal(payload.email, "owner@example.com");
});

test("rejects a JWT for another Access application", async () => {
  const fixture = await fixtureJwt();
  await assert.rejects(() => verifyAccessJwt(fixture.token, {
    teamDomain: "https://team.cloudflareaccess.com",
    policyAud: "another-audience"
  }, {
    now: 1_900_000_000,
    fetchImpl: async () => new Response(JSON.stringify({ keys: [fixture.jwk] }))
  }), /audience/);
});

test("rejects an expired Access JWT", async () => {
  const fixture = await fixtureJwt({ exp: 1_800_000_000 });
  await assert.rejects(() => verifyAccessJwt(fixture.token, {
    teamDomain: "https://team.cloudflareaccess.com",
    policyAud: "r2beam-audience"
  }, { now: 1_900_000_000 }), /만료/);
});

test("rejects a malformed Access JWT as an authentication error", async () => {
  await assert.rejects(() => verifyAccessJwt("not-json.payload.signature", {
    teamDomain: "https://team.cloudflareaccess.com",
    policyAud: "r2beam-audience"
  }), /형식/);
});

test("allows development bypass only on localhost", () => {
  const env = { DEV_AUTH_BYPASS: "true" };
  assert.equal(localAuthEnabled(env, new Request("http://localhost:8787")), true);
  assert.equal(localAuthEnabled(env, new Request("https://r2beam.example.com")), false);
});
