export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 90 * 1024 * 1024;

const MEDIA_VARIANTS = new Set(["single", "original", "optimized"]);

function bytesEqual(bytes, signature, offset = 0) {
  return signature.every((value, index) => bytes[offset + index] === value);
}

export function detectMediaType(bytes) {
  if (bytesEqual(bytes, [0xff, 0xd8, 0xff])) return { kind: "image", contentType: "image/jpeg", extension: "jpg" };
  if (bytesEqual(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "image", contentType: "image/png", extension: "png" };
  if (bytesEqual(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return { kind: "image", contentType: "image/gif", extension: "gif" };
  if (bytesEqual(bytes, [0x52, 0x49, 0x46, 0x46]) && bytesEqual(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return { kind: "image", contentType: "image/webp", extension: "webp" };
  if (bytesEqual(bytes, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = new TextDecoder().decode(bytes.slice(8, 16));
    if (brand.includes("avif") || brand.includes("avis")) return { kind: "image", contentType: "image/avif", extension: "avif" };
    if (/isom|iso2|mp4[12]|avc1|M4V |MSNV|dash/.test(brand)) return { kind: "video", contentType: "video/mp4", extension: "mp4" };
  }
  if (bytesEqual(bytes, [0x49, 0x44, 0x33]) || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) {
    return { kind: "audio", contentType: "audio/mpeg", extension: "mp3" };
  }
  return null;
}

export function normalizeMediaVariant(value) {
  const variant = String(value || "single").trim().toLowerCase();
  return MEDIA_VARIANTS.has(variant) ? variant : "single";
}

export function validMediaKey(key) {
  return /^(?:image|audio|video)\/\d{4}\/\d{2}\/\d{2}-[0-9a-f-]+-(?:single|original|optimized)\.(?:jpe?g|png|gif|webp|avif|mp3|mp4)$/i.test(String(key || ""));
}

export function parseByteRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(value || "").trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return null;
    end = Math.min(end, size - 1);
  }
  return { offset: start, length: end - start + 1, start, end };
}
