const IMAGE_MAX_LONG_EDGE = 960;
const IMAGE_WEBP_QUALITY = 0.78;
const FFMPEG_BASE_URL = "/vendor/ffmpeg";
const STORAGE_MODE_KEY = "media-vault-storage-mode";
const state = { cursor: null, items: [], busy: false, ffmpegProgressLabel: "" };
const $ = (selector) => document.querySelector(selector);

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...options });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    location.reload();
    throw new Error("로그인이 필요합니다.");
  }
  if (!response.ok) throw new Error(data.message || "요청을 처리하지 못했습니다.");
  return data;
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 3000);
}

function setProgress(message) {
  $("#progress").textContent = message;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function filenameWithExtension(name, extension) {
  const base = String(name || "media").replace(/\.[^.]+$/, "") || "media";
  return `${base}.${extension}`;
}

function mediaKindForFile(file) {
  const type = String(file.type || "").toLowerCase();
  const name = String(file.name || "").toLowerCase();
  if (type.startsWith("audio/") || name.endsWith(".mp3")) return "audio";
  if (type.startsWith("video/") || name.endsWith(".mp4")) return "video";
  return "image";
}

function itemKind(item) {
  if (item.kind) return item.kind;
  if (item.contentType?.startsWith("audio/")) return "audio";
  if (item.contentType?.startsWith("video/")) return "video";
  return "image";
}

function supportedMediaFile(file) {
  const type = String(file.type || "").toLowerCase();
  const name = String(file.name || "").toLowerCase();
  return ["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "audio/mpeg", "video/mp4"].includes(type)
    || /\.(?:jpe?g|png|gif|webp|avif|mp3|mp4)$/.test(name);
}

function targetImageSize(width, height) {
  const scale = Math.min(1, IMAGE_MAX_LONG_EDGE / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

async function loadImageSource(file) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.() };
    } catch {
      try {
        const bitmap = await createImageBitmap(file);
        return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.() };
      } catch {
        // iOS Safari can decode an image element even when createImageBitmap fails.
      }
    }
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("이 브라우저에서 이미지를 읽을 수 없습니다."));
      image.src = objectUrl;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(objectUrl)
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function canvasHasTransparency(context, width, height) {
  try {
    const pixels = context.getImageData(0, 0, width, height).data;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] !== 255) return true;
    }
    return false;
  } catch {
    return true;
  }
}

async function encodeBoardImage(canvas, context, file) {
  const webp = await canvasBlob(canvas, "image/webp", IMAGE_WEBP_QUALITY).catch(() => null);
  if (webp?.type === "image/webp") return { blob: webp, type: "image/webp", extension: "webp" };

  const sourceType = String(file.type || "").toLowerCase();
  const preserveAlpha = sourceType !== "image/jpeg"
    && canvasHasTransparency(context, canvas.width, canvas.height);
  const type = preserveAlpha ? "image/png" : "image/jpeg";
  const extension = preserveAlpha ? "png" : "jpg";
  const fallback = await canvasBlob(canvas, type, preserveAlpha ? undefined : IMAGE_WEBP_QUALITY);
  if (!fallback || fallback.type !== type) throw new Error("이 브라우저에서 이미지를 최적화할 수 없습니다.");
  return { blob: fallback, type, extension };
}

async function isAnimatedImage(file) {
  const type = String(file.type || "").toLowerCase();
  const name = String(file.name || "").toLowerCase();
  if (type === "image/gif" || name.endsWith(".gif")) return true;
  const header = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
  const text = new TextDecoder("latin1").decode(header);
  if (type === "image/webp" || name.endsWith(".webp")) return text.includes("ANIM") || text.includes("ANMF");
  if (type === "image/avif" || name.endsWith(".avif")) return text.slice(0, 32).includes("avis");
  return false;
}

async function convertImageForBoard(file) {
  if (await isAnimatedImage(file)) {
    throw new Error("움직이는 이미지는 애니메이션 보존을 위해 원본으로 저장합니다.");
  }

  let decoded;
  try {
    decoded = await loadImageSource(file);
    const size = targetImageSize(decoded.width, decoded.height);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("이미지 변환기를 시작할 수 없습니다.");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(decoded.source, 0, 0, size.width, size.height);
    const output = await encodeBoardImage(canvas, context, file);
    return new File([output.blob], filenameWithExtension(file.name, output.extension), {
      type: output.type,
      lastModified: file.lastModified
    });
  } catch (error) {
    throw new Error(`${file.name}: ${error.message || "이미지 최적화에 실패했습니다."}`);
  } finally {
    decoded?.close?.();
  }
}

let ffmpegPromise;
let ffmpegWasmObjectUrl;

async function loadFfmpegWasmUrl() {
  if (ffmpegWasmObjectUrl) return ffmpegWasmObjectUrl;
  if (typeof DecompressionStream !== "function") {
    throw new Error("이 브라우저는 영상 변환 엔진 압축 해제를 지원하지 않습니다.");
  }
  const response = await fetch(`${FFMPEG_BASE_URL}/ffmpeg-core.wasm.gz`, { credentials: "same-origin" });
  if (!response.ok || !response.body) throw new Error("영상 변환 엔진을 내려받지 못했습니다.");
  const decompressed = response.body.pipeThrough(new DecompressionStream("gzip"));
  const wasmBlob = await new Response(decompressed, {
    headers: { "content-type": "application/wasm" }
  }).blob();
  ffmpegWasmObjectUrl = URL.createObjectURL(wasmBlob);
  return ffmpegWasmObjectUrl;
}

async function loadFfmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      setProgress("영상 변환 엔진을 처음 불러오는 중… (약 32MB)");
      const { FFmpeg } = await import(`${FFMPEG_BASE_URL}/index.js`);
      const ffmpeg = new FFmpeg();
      ffmpeg.on("progress", ({ progress }) => {
        if (!state.ffmpegProgressLabel || !Number.isFinite(progress)) return;
        const percent = Math.max(0, Math.min(100, Math.round(progress * 100)));
        setProgress(`${state.ffmpegProgressLabel} · ${percent}%`);
      });
      await ffmpeg.load({
        coreURL: `${FFMPEG_BASE_URL}/ffmpeg-core.js`,
        wasmURL: await loadFfmpegWasmUrl()
      });
      return ffmpeg;
    })().catch((error) => {
      ffmpegPromise = null;
      throw error;
    });
  }
  return ffmpegPromise;
}

async function convertVideoForBoard(file, label) {
  const ffmpeg = await loadFfmpeg();
  const token = crypto.randomUUID().replaceAll("-", "");
  const inputName = `input-${token}.mp4`;
  const outputName = `beebs-${token}.mp4`;
  state.ffmpegProgressLabel = `${label} · MP4 변환 중`;
  try {
    await ffmpeg.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));
    const exitCode = await ffmpeg.exec([
      "-i", inputName,
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-map_metadata", "-1",
      "-map_chapters", "-1",
      "-sn",
      "-dn",
      "-vf", "scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps='min(source_fps,30)'",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "29",
      "-pix_fmt", "yuv420p",
      "-metadata:s:v:0", "rotate=0",
      "-c:a", "aac",
      "-b:a", "96k",
      "-movflags", "+faststart",
      outputName
    ]);
    if (exitCode !== 0) throw new Error(`영상 변환기가 종료 코드 ${exitCode}을 반환했습니다.`);
    const data = await ffmpeg.readFile(outputName);
    return new File([data], filenameWithExtension(file.name, "mp4"), {
      type: "video/mp4",
      lastModified: file.lastModified
    });
  } catch (error) {
    throw new Error(`${file.name}: ${error.message || "MP4 변환에 실패했습니다."}`);
  } finally {
    state.ffmpegProgressLabel = "";
    await ffmpeg.deleteFile(inputName).catch(() => {});
    await ffmpeg.deleteFile(outputName).catch(() => {});
  }
}

function embedCode(item) {
  const kind = itemKind(item);
  if (kind === "audio") return `<audio controls src="${item.url}"></audio>`;
  if (kind === "video") return `<video controls preload="metadata" playsinline src="${item.url}"></video>`;
  return `![${item.originalName}](${item.url})`;
}

function copyLabel(item) {
  return itemKind(item) === "image" ? "Markdown" : "Embed";
}

async function copy(text, message) {
  await navigator.clipboard.writeText(text);
  toast(message);
}

function groupedItems() {
  const groups = new Map();
  for (const item of state.items) {
    const groupId = item.groupId || item.key;
    const group = groups.get(groupId) || { groupId, items: [], original: null, optimized: null, single: null };
    group.items.push(item);
    if (item.variant === "original") group.original = item;
    else if (item.variant === "optimized") group.optimized = item;
    else group.single = item;
    groups.set(groupId, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, primary: group.optimized || group.single || group.original }))
    .sort((a, b) => String(b.primary?.uploadedAt).localeCompare(String(a.primary?.uploadedAt)));
}

function createPreview(item) {
  const kind = itemKind(item);
  if (kind === "audio") {
    const preview = document.createElement("div");
    preview.className = "media-preview audio-preview";
    const icon = document.createElement("div");
    icon.className = "media-icon";
    icon.textContent = "♫";
    const player = document.createElement("audio");
    player.controls = true;
    player.preload = "metadata";
    player.src = item.url;
    preview.append(icon, player);
    return preview;
  }
  if (kind === "video") {
    const preview = document.createElement("video");
    preview.className = "media-preview video-preview";
    preview.controls = true;
    preview.preload = "metadata";
    preview.playsInline = true;
    preview.src = item.url;
    return preview;
  }
  const preview = document.createElement("img");
  preview.className = "media-preview thumb";
  preview.src = item.url;
  preview.alt = item.originalName;
  preview.loading = "lazy";
  return preview;
}

function render() {
  const groups = groupedItems();
  const gallery = $("#gallery");
  gallery.replaceChildren(...groups.map((group) => {
    const item = group.primary;
    const card = document.createElement("article");
    card.className = "card";
    const info = document.createElement("div");
    info.className = "card-info";
    const filename = document.createElement("div");
    filename.className = "filename";
    filename.title = item.originalName;
    filename.textContent = item.originalName;
    const meta = document.createElement("div");
    meta.className = "meta";
    const sizes = [];
    if (group.optimized) sizes.push(`게시판용 ${formatBytes(group.optimized.size)}`);
    if (group.original) sizes.push(`원본 ${formatBytes(group.original.size)}`);
    if (group.single) sizes.push(formatBytes(group.single.size));
    const date = item.uploadedAt ? new Date(item.uploadedAt).toLocaleDateString("ko-KR") : "";
    meta.textContent = `${sizes.join(" · ")}${date ? ` · ${date}` : ""}`;
    const actions = document.createElement("div");
    actions.className = "actions";
    const urlButton = document.createElement("button");
    urlButton.textContent = group.optimized ? "게시판 URL" : "URL";
    urlButton.onclick = () => copy(item.url, "미디어 URL을 복사했습니다.");
    const embedButton = document.createElement("button");
    embedButton.textContent = copyLabel(item);
    embedButton.onclick = () => copy(embedCode(item), `${copyLabel(item)} 코드를 복사했습니다.`);
    actions.append(urlButton, embedButton);
    if (group.original && group.original.key !== item.key) {
      const originalButton = document.createElement("button");
      originalButton.textContent = "원본 URL";
      originalButton.onclick = () => copy(group.original.url, "원본 URL을 복사했습니다.");
      actions.append(originalButton);
    }
    const deleteButton = document.createElement("button");
    deleteButton.className = "delete";
    deleteButton.textContent = "삭제";
    deleteButton.onclick = () => removeMediaGroup(group);
    actions.append(deleteButton);
    info.append(filename, meta, actions);
    card.append(createPreview(item), info);
    return card;
  }));
  $("#empty").hidden = groups.length > 0;
  $("#load-more").hidden = !state.cursor;
}

async function loadMedia(append = false) {
  const query = new URLSearchParams({ limit: "100" });
  if (append && state.cursor) query.set("cursor", state.cursor);
  const data = await api(`/api/media?${query}`);
  const items = data.items.filter((item) => !String(item.key || "").startsWith("_r2beam/"));
  state.items = append ? [...state.items, ...items] : items;
  state.cursor = data.cursor;
  render();
}

function selectedStorageMode() {
  return document.querySelector('input[name="storage-mode"]:checked')?.value || "both";
}

async function prepareVariants(file, mode, progressLabel) {
  const kind = mediaKindForFile(file);
  if (kind === "audio" || mode === "original") return [{ file, variant: "original" }];
  if (kind === "image" && await isAnimatedImage(file)) {
    toast(`${file.name}: 움직이는 이미지는 원본으로 저장합니다.`);
    return [{ file, variant: "original" }];
  }

  try {
    const optimized = kind === "video"
      ? await convertVideoForBoard(file, progressLabel)
      : await convertImageForBoard(file);
    return mode === "optimized"
      ? [{ file: optimized, variant: "optimized" }]
      : [{ file, variant: "original" }, { file: optimized, variant: "optimized" }];
  } catch (error) {
    if (mode === "optimized") {
      throw new Error(`${error.message} 원본은 업로드하지 않았습니다.`);
    }
    toast(`${error.message} 원본만 업로드합니다.`);
    return [{ file, variant: "original" }];
  }
}

async function uploadVariant({ file, variant }, groupId, originalName, label) {
  setProgress(`${label} · ${variant === "optimized" ? "게시판용" : "원본"} 업로드 중…`);
  const form = new FormData();
  form.append("file", file);
  form.append("variant", variant);
  form.append("groupId", groupId);
  form.append("originalName", originalName);
  const data = await api("/api/media/upload", { method: "POST", body: form });
  return data.item;
}

async function uploadFiles(files) {
  const mediaFiles = [...files].filter(supportedMediaFile);
  if (!mediaFiles.length || state.busy) return;
  state.busy = true;
  $("#progress").hidden = false;
  const uploadedGroups = [];
  const mode = selectedStorageMode();
  try {
    for (let index = 0; index < mediaFiles.length; index += 1) {
      const original = mediaFiles[index];
      const label = `${index + 1}/${mediaFiles.length} · ${original.name}`;
      setProgress(`${label} · 게시판용 미디어 준비 중…`);
      const variants = await prepareVariants(original, mode, label);
      const groupId = crypto.randomUUID();
      const uploaded = [];
      for (const variant of variants) {
        uploaded.push(await uploadVariant(variant, groupId, original.name, label));
      }
      uploadedGroups.push(uploaded);
    }
    await loadMedia();
    const primaryItems = uploadedGroups.map((items) => items.find((item) => item.variant === "optimized") || items[0]);
    if (primaryItems.length === 1) {
      await copy(embedCode(primaryItems[0]), `업로드 완료 · ${copyLabel(primaryItems[0])} 코드를 복사했습니다.`);
    } else {
      await copy(primaryItems.map(embedCode).join("\n\n"), `${primaryItems.length}개 업로드 완료 · 삽입 코드를 복사했습니다.`);
    }
  } catch (error) {
    toast(error.message);
  } finally {
    state.busy = false;
    state.ffmpegProgressLabel = "";
    $("#progress").hidden = true;
    $("#file-input").value = "";
  }
}

async function removeMediaGroup(group) {
  if (!confirm(`“${group.primary.originalName}” 파일을 삭제할까요?\n원본과 게시판용 파일이 모두 삭제되며 외부 링크도 깨집니다.`)) return;
  const keys = group.items.map((item) => item.key);
  try {
    await api("/api/media/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys })
    });
    const deleted = new Set(keys);
    state.items = state.items.filter((item) => !deleted.has(item.key));
    render();
    toast("미디어 파일을 삭제했습니다.");
  } catch (error) {
    toast(error.message);
  }
}

function initializeStorageMode() {
  const saved = localStorage.getItem(STORAGE_MODE_KEY);
  const selected = document.querySelector(`input[name="storage-mode"][value="${saved}"]`);
  if (selected) selected.checked = true;
  for (const input of document.querySelectorAll('input[name="storage-mode"]')) {
    input.addEventListener("change", () => localStorage.setItem(STORAGE_MODE_KEY, selectedStorageMode()));
  }
}

async function boot() {
  const me = await api("/api/media/me");
  if (!me.authenticated) return location.replace("/");
  $("#user-email").textContent = me.user.email;
  initializeStorageMode();
  await loadMedia();
}

const dropzone = $("#dropzone");
dropzone.onclick = () => $("#file-input").click();
dropzone.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") $("#file-input").click(); };
dropzone.ondragover = (event) => { event.preventDefault(); dropzone.classList.add("dragging"); };
dropzone.ondragleave = () => dropzone.classList.remove("dragging");
dropzone.ondrop = (event) => { event.preventDefault(); dropzone.classList.remove("dragging"); uploadFiles(event.dataTransfer.files); };
$("#file-input").onchange = (event) => uploadFiles(event.target.files);
document.addEventListener("paste", (event) => uploadFiles(event.clipboardData.files));
$("#refresh").onclick = () => loadMedia().catch((error) => toast(error.message));
$("#load-more").onclick = () => loadMedia(true).catch((error) => toast(error.message));
$("#logout").onclick = () => { location.assign("/cdn-cgi/access/logout"); };
boot().catch((error) => toast(error.message));
