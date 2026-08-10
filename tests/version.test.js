import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions, updateStatus } from "../public/version.js";

test("compares semantic release versions", () => {
  assert.equal(compareVersions("0.1.3", "0.1.2"), 1);
  assert.equal(compareVersions("v0.1.3", "0.1.3"), 0);
  assert.equal(compareVersions("0.2.0", "0.10.0"), -1);
  assert.equal(compareVersions("dev", "0.1.3"), null);
});

test("classifies normal and required updates", () => {
  assert.equal(updateStatus("0.1.3", { latestVersion: "0.1.4", minimumVersion: "0.1.3" }), "available");
  assert.equal(updateStatus("0.1.3", { latestVersion: "0.2.0", minimumVersion: "0.1.4" }), "required");
  assert.equal(updateStatus("0.1.3", { latestVersion: "0.1.3", minimumVersion: "0.1.3" }), "current");
  assert.equal(updateStatus("dev", { latestVersion: "0.1.3", minimumVersion: "0.1.3" }), null);
});
