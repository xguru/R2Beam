import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

const installerRoot = resolve(import.meta.dirname, "..");
const projectRoot = resolve(installerRoot, "..");
const releaseRoot = join(installerRoot, "release");
const filesRoot = join(releaseRoot, "files");
const bundleRoot = join(releaseRoot, ".bundle");

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".gz": "application/gzip"
};

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code}`)));
  });
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}

await rm(releaseRoot, { recursive: true, force: true });
await mkdir(filesRoot, { recursive: true });
await run("npm", ["run", "build"], projectRoot);
await run("npx", ["wrangler", "deploy", "--dry-run", "--outdir", bundleRoot], projectRoot);

const publicRoot = join(projectRoot, "public");
const sourceFiles = await walk(publicRoot);
const manifest = [];
for (const source of sourceFiles) {
  const path = relative(publicRoot, source).split("\\").join("/");
  const destination = join(filesRoot, path);
  await mkdir(resolve(destination, ".."), { recursive: true });
  await cp(source, destination);
  manifest.push({ path: `/${path}`, source: `/files/${path}`, contentType: types[extname(path)] || "application/octet-stream" });
}

await cp(join(bundleRoot, "index.js"), join(releaseRoot, "r2beam-worker.js"));
await writeFile(join(releaseRoot, "manifest.json"), JSON.stringify({ version: "0.1.0", assets: manifest }, null, 2));
await rm(bundleRoot, { recursive: true, force: true });
console.log(`Prepared R2Beam release with ${manifest.length} assets.`);
