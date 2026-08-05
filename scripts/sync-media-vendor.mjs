import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

const root = process.cwd();
const ffmpegSource = path.join(root, "node_modules/@ffmpeg/ffmpeg/dist/esm");
const coreSource = path.join(root, "node_modules/@ffmpeg/core/dist/esm");
const target = path.join(root, "public/vendor/ffmpeg");
const gzipAsync = promisify(gzip);

await mkdir(target, { recursive: true });

for (const name of await readdir(ffmpegSource)) {
  if (name.endsWith(".js")) {
    const source = await readFile(path.join(ffmpegSource, name), "utf8");
    await writeFile(path.join(target, name), source.replace(/[ \t]+$/gm, ""));
  }
}

const coreJavaScript = await readFile(path.join(coreSource, "ffmpeg-core.js"), "utf8");
await writeFile(path.join(target, "ffmpeg-core.js"), coreJavaScript.replace(/[ \t]+$/gm, ""));
const wasm = await readFile(path.join(coreSource, "ffmpeg-core.wasm"));
await writeFile(path.join(target, "ffmpeg-core.wasm.gz"), await gzipAsync(wasm, { level: 9 }));
await unlink(path.join(target, "ffmpeg-core.wasm")).catch((error) => {
  if (error.code !== "ENOENT") throw error;
});

console.log(`Synced ffmpeg.wasm browser assets to ${path.relative(root, target)}`);
