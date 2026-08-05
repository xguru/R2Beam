const ASSET_PREFIX = "_r2beam/assets";

function assetKey(pathname) {
  const path = pathname === "/" ? "/index.html" : pathname;
  if (!path.startsWith("/") || path.includes("..")) return null;
  return `${ASSET_PREFIX}${path}`;
}

export async function serveAsset(env, request, pathname) {
  if (env.ASSETS?.fetch) {
    const url = new URL(request.url);
    url.pathname = pathname;
    return env.ASSETS.fetch(new Request(url, request));
  }

  const key = assetKey(pathname);
  if (!key || !env.MEDIA?.get) return new Response("Not found", { status: 404 });
  const object = request.method === "HEAD" ? await env.MEDIA.head(key) : await env.MEDIA.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", pathname.startsWith("/vendor/") ? "public, max-age=31536000, immutable" : "no-cache");
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

export { ASSET_PREFIX };
