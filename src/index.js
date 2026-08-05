import {
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  detectMediaType,
  normalizeMediaVariant,
  parseByteRange,
  validMediaKey
} from "./media.js";
import { AccessDeniedError, accessIdentity, localAuthEnabled } from "./access.js";
import { ASSET_PREFIX, serveAsset } from "./assets.js";

const GROUP_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REMOVED_SETUP_PATHS = new Set(["/setup", "/setup.html", "/setup.js", "/setup.css", "/api/setup"]);
function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders }
  });
}

function error(code, message, status) {
  return json({ ok: false, code, message }, status);
}

function sameOrigin(request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

function requireBucket(env) {
  if (!env.MEDIA?.put || !env.MEDIA?.get || !env.MEDIA?.list || !env.MEDIA?.delete) throw new Error("MEDIA R2 바인딩이 필요합니다.");
  return env.MEDIA;
}

function accessConfigured(env) {
  return Boolean(String(env.TEAM_DOMAIN || "").trim() && String(env.POLICY_AUD || "").trim());
}

function maxBytes(kind) {
  return kind === "video" ? MAX_VIDEO_BYTES : kind === "audio" ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES;
}

function safeOriginalName(value) {
  return String(value || "media").replace(/[\u0000-\u001f\u007f]/g, "").replace(/[\\/]/g, "-").trim().slice(0, 180) || "media";
}

function publicUrl(request, key) {
  return `${new URL(request.url).origin}/media/${key.split("/").map(encodeURIComponent).join("/")}`;
}

async function uploadMedia(env, request) {
  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file.stream !== "function") return error("missing_file", "업로드할 미디어 파일이 필요합니다.", 400);
  const detected = detectMediaType(new Uint8Array(await file.slice(0, 32).arrayBuffer()));
  if (!detected) return error("unsupported_media", "JPG, PNG, GIF, WebP, AVIF, MP3, MP4 파일만 업로드할 수 있습니다.", 415);
  if (file.size <= 0 || file.size > maxBytes(detected.kind)) return error("file_too_large", "파일 크기 제한을 초과했습니다.", 413);

  const requestedGroupId = String(form.get("groupId") || "");
  const groupId = GROUP_ID_PATTERN.test(requestedGroupId) ? requestedGroupId : crypto.randomUUID();
  const variant = normalizeMediaVariant(form.get("variant"));
  const [year, month, day] = new Date().toISOString().slice(0, 10).split("-");
  const key = `${detected.kind}/${year}/${month}/${day}-${groupId}-${variant}.${detected.extension}`;
  const originalName = safeOriginalName(form.get("originalName") || file.name);
  const uploadedAt = new Date().toISOString();
  await requireBucket(env).put(key, file.stream(), {
    httpMetadata: { contentType: detected.contentType, cacheControl: "public, max-age=31536000, immutable", contentDisposition: "inline" },
    customMetadata: { originalName, uploadedAt, mediaKind: detected.kind, mediaVariant: variant, mediaGroupId: groupId }
  });
  return json({ ok: true, item: { key, url: publicUrl(request, key), kind: detected.kind, variant, groupId, size: file.size, contentType: detected.contentType, originalName, uploadedAt } }, 201);
}

async function listMedia(env, request) {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 60), 1), 100);
  const bucket = requireBucket(env);
  let cursor = url.searchParams.get("cursor") || undefined;
  let truncated = false;
  const objects = [];
  do {
    const result = await bucket.list({ limit: limit - objects.length, cursor, include: ["httpMetadata", "customMetadata"] });
    objects.push(...result.objects.filter((object) => !object.key.startsWith(`${ASSET_PREFIX}/`)));
    truncated = result.truncated;
    cursor = result.cursor;
  } while (objects.length < limit && truncated);
  const items = objects.map((object) => ({
    key: object.key,
    url: publicUrl(request, object.key),
    kind: object.customMetadata?.mediaKind || object.key.split("/", 1)[0],
    variant: object.customMetadata?.mediaVariant || "single",
    groupId: object.customMetadata?.mediaGroupId || object.key,
    size: object.size,
    uploadedAt: object.customMetadata?.uploadedAt || object.uploaded?.toISOString?.() || null,
    originalName: object.customMetadata?.originalName || object.key.split("/").pop(),
    contentType: object.httpMetadata?.contentType || "application/octet-stream"
  })).sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
  return json({ items, truncated, cursor: truncated ? cursor : null });
}

async function serveMedia(env, request, key) {
  if (!validMediaKey(key)) return new Response("Not found", { status: 404 });
  const bucket = requireBucket(env);
  if (request.method === "HEAD") {
    const head = await bucket.head(key);
    if (!head) return new Response("Not found", { status: 404 });
    const headers = new Headers();
    head.writeHttpMetadata(headers);
    headers.set("etag", head.httpEtag);
    headers.set("accept-ranges", "bytes");
    return new Response(null, { headers });
  }
  const head = await bucket.head(key);
  if (!head) return new Response("Not found", { status: 404 });
  if (request.headers.get("if-none-match") === head.httpEtag) return new Response(null, { status: 304, headers: { etag: head.httpEtag } });
  const rangeHeader = request.headers.get("range");
  const range = rangeHeader ? parseByteRange(rangeHeader, head.size) : null;
  if (rangeHeader && !range) return new Response(null, { status: 416, headers: { "content-range": `bytes */${head.size}` } });
  const object = await bucket.get(key, range ? { range: { offset: range.offset, length: range.length } } : undefined);
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "public, max-age=31536000, immutable");
  if (range) {
    headers.set("content-range", `bytes ${range.start}-${range.end}/${head.size}`);
    headers.set("content-length", String(range.length));
  }
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

async function handleApi(env, request, path, identity) {
  if (request.method === "GET" && path === "/api/media/me") return json({ authenticated: true, user: identity });
  if (request.method !== "GET" && !sameOrigin(request)) return error("invalid_origin", "잘못된 요청 출처입니다.", 403);
  if (request.method === "GET" && path === "/api/media") return listMedia(env, request);
  if (request.method === "POST" && path === "/api/media/upload") return uploadMedia(env, request);
  if (request.method === "POST" && path === "/api/media/delete") {
    const body = await request.json().catch(() => ({}));
    const keys = Array.isArray(body.keys) ? body.keys.map(String) : [String(body.key || "")];
    if (!keys.length || keys.length > 4 || keys.some((key) => !validMediaKey(key))) return error("invalid_key", "삭제할 미디어 경로가 올바르지 않습니다.", 400);
    await requireBucket(env).delete(keys.length === 1 ? keys[0] : keys);
    return json({ ok: true });
  }
  return error("not_found", "요청한 API를 찾을 수 없습니다.", 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if ((request.method === "GET" || request.method === "HEAD") && path.startsWith("/media/")) {
        return serveMedia(env, request, decodeURIComponent(path.slice(7)));
      }
      if (REMOVED_SETUP_PATHS.has(path)) {
        return path.startsWith("/api/") ? error("not_found", "요청한 API를 찾을 수 없습니다.", 404) : new Response("Not found", { status: 404 });
      }
      const local = localAuthEnabled(env, request);
      if (!local && !accessConfigured(env)) {
        return new Response("R2Beam installation is still being configured.", { status: 503, headers: { "cache-control": "no-store" } });
      }
      const identity = await accessIdentity(env, request);
      if (path.startsWith("/api/")) return handleApi(env, request, path, identity);
      if (path === "/" || path === "/index.html") return serveAsset(env, request, "/index.html");
      return serveAsset(env, request, path);
    } catch (caught) {
      const denied = caught instanceof AccessDeniedError;
      if (!denied) console.error(caught);
      const message = caught?.message || "Cloudflare Access 인증에 실패했습니다.";
      const status = denied ? 401 : 503;
      if (path.startsWith("/api/")) {
        return error(denied ? "access_denied" : "access_not_configured", message, status);
      }
      return new Response(message, {
        status,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
      });
    }
  }
};
