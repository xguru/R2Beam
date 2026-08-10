import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

function object(key) {
  return {
    key,
    size: 123,
    uploaded: new Date("2026-08-05T00:00:00Z"),
    httpMetadata: { contentType: "image/webp" },
    customMetadata: {}
  };
}

test("hides installer assets from the media library and continues pagination", async () => {
  const calls = [];
  const pages = [
    { objects: [object("_r2beam/assets/index.html")], truncated: true, cursor: "next" },
    { objects: [object("image/2026/08/photo.webp")], truncated: false }
  ];
  const media = {
    put() {}, get() {}, delete() {},
    async list(options) {
      calls.push(options);
      return pages.shift();
    }
  };

  const response = await worker.fetch(new Request("http://localhost:8787/api/media?limit=1"), {
    MEDIA: media,
    DEV_AUTH_BYPASS: "true"
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.items.map((item) => item.key), ["image/2026/08/photo.webp"]);
  assert.equal(body.truncated, false);
  assert.equal(body.cursor, null);
  assert.deepEqual(calls.map((call) => call.cursor), [undefined, "next"]);
});

test("does not expose the removed setup routes", async () => {
  const env = { DEV_AUTH_BYPASS: "true" };
  for (const path of ["/setup", "/setup.html", "/setup.js", "/setup.css", "/api/setup"]) {
    const response = await worker.fetch(new Request(`http://localhost:8787${path}`), env);
    assert.equal(response.status, 404, path);
  }
});

test("reports the installed R2Beam version", async () => {
  const response = await worker.fetch(new Request("http://localhost:8787/api/media/me"), {
    DEV_AUTH_BYPASS: "true",
    R2BEAM_VERSION: "0.1.3"
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).version, "0.1.3");
});

test("checks the central version policy without forwarding user data", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(url, "https://r2beam.xguru.net/version.json");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("cf-access-jwt-assertion"), null);
    assert.equal(headers.get("accept"), "application/json");
    return Response.json({ latestVersion: "0.1.4", minimumVersion: "0.1.3", installerUrl: "https://r2beam.xguru.net/" });
  };
  try {
    const response = await worker.fetch(new Request("http://localhost:8787/api/media/version"), { DEV_AUTH_BYPASS: "true" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      latestVersion: "0.1.4",
      minimumVersion: "0.1.3",
      installerUrl: "https://r2beam.xguru.net/"
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
