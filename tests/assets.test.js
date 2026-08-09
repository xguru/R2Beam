import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ASSET_PREFIX, serveAsset } from "../src/assets.js";

test("serves installer-managed assets from the media bucket", async () => {
  let requestedKey;
  const object = {
    body: "ok",
    httpEtag: '"asset"',
    writeHttpMetadata(headers) { headers.set("content-type", "text/html"); }
  };
  const env = { MEDIA: { async get(key) { requestedKey = key; return object; } } };
  const response = await serveAsset(env, new Request("https://vault.example/"), "/index.html");
  assert.equal(requestedKey, `${ASSET_PREFIX}/index.html`);
  assert.equal(await response.text(), "ok");
  assert.equal(response.headers.get("content-type"), "text/html");
});

test("prefers the static assets binding for normal deployments", async () => {
  let requestedPath;
  const env = { ASSETS: { async fetch(request) { requestedPath = new URL(request.url).pathname; return new Response("bound"); } } };
  const response = await serveAsset(env, new Request("https://vault.example/"), "/app.js");
  assert.equal(requestedPath, "/app.js");
  assert.equal(await response.text(), "bound");
});

test("links the installed vault to the public source repository", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /https:\/\/github\.com\/xguru\/R2Beam/);
  assert.match(html, /GitHub · Source Code/);
  assert.match(html, /id="app-version"/);
});
