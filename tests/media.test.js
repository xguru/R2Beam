import test from "node:test";
import assert from "node:assert/strict";
import { detectMediaType, normalizeMediaVariant, parseByteRange, validMediaKey } from "../src/media.js";

test("detects supported signatures instead of trusting extensions", () => {
  assert.deepEqual(detectMediaType(Uint8Array.from([0xff, 0xd8, 0xff, 0x00])), { kind: "image", contentType: "image/jpeg", extension: "jpg" });
  assert.deepEqual(detectMediaType(Uint8Array.from([0x49, 0x44, 0x33, 0x04])), { kind: "audio", contentType: "audio/mpeg", extension: "mp3" });
  assert.equal(detectMediaType(Uint8Array.from([1, 2, 3, 4])), null);
});

test("normalizes media variants", () => {
  assert.equal(normalizeMediaVariant("OPTIMIZED"), "optimized");
  assert.equal(normalizeMediaVariant("unknown"), "single");
});

test("accepts generated object keys and rejects traversal", () => {
  assert.equal(validMediaKey("image/2026/08/05-82e04ffc-5400-4c5b-96c1-b7c008d34fc0-optimized.webp"), true);
  assert.equal(validMediaKey("../secret"), false);
});

test("parses normal, open, and suffix ranges", () => {
  assert.deepEqual(parseByteRange("bytes=10-19", 100), { offset: 10, length: 10, start: 10, end: 19 });
  assert.deepEqual(parseByteRange("bytes=90-", 100), { offset: 90, length: 10, start: 90, end: 99 });
  assert.deepEqual(parseByteRange("bytes=-10", 100), { offset: 90, length: 10, start: 90, end: 99 });
  assert.equal(parseByteRange("bytes=100-101", 100), null);
});
