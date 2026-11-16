// Builds the Chrome extension and publishes it to Supabase Storage so the home
// page can offer it for download.
//
//   On Vercel (every deploy): if this version is already published, do nothing:
//   no extension install, no build, and the same zip keeps being served. If not,
//   build it, zip it and publish it. Backend-only deploys therefore stay fast.
//
//   Locally:  npm run package:extension              build + zip into .extension-release/ (no upload)
//             npm run package:extension -- --publish also upload it (refuses with uncommitted extension changes)
//
// A version is published once and never replaced, so bump "version" in
// chrome-extension/package.json whenever the extension changes (see AGENTS.md).
//
// Default backend of the build: the extension's own default
// (chrome-extension/src/api/backend.ts), unless DONNA_BACKEND_URL overrides it.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import {
  findRelease,
  publishRelease,
  releaseFileName,
  RELEASE_BUCKET,
  releasePath,
  storageConfigured,
} from "../lib/extension/release.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = join(root, "chrome-extension");
const buildDir = join(extensionDir, "dist-package");
const localDir = join(root, ".extension-release");
const onVercel = Boolean(process.env.VERCEL);
const publishing = onVercel || process.argv.includes("--publish");
// Vercel provides its environment variables; locally they live in .env.local.
if (!onVercel && existsSync(join(root, ".env.local"))) process.loadEnvFile(join(root, ".env.local"));

function backendUrl() {
  const explicit = process.env.DONNA_BACKEND_URL?.trim();
  return explicit ? new URL(explicit).origin : undefined;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`${options.label ?? command} failed.`);
}

// Only installed when a build is actually needed, so skipped deploys stay fast.
function ensureExtensionDependencies() {
  if (existsSync(join(extensionDir, "node_modules", "vite"))) return;
  console.log("Installing the extension's dependencies...");
  const npmCli = process.env.npm_execpath;
  if (npmCli) {
    run(process.execPath, [npmCli, "ci", "--prefix", extensionDir], { label: "npm ci" });
  } else {
    run("npm", ["ci", "--prefix", extensionDir], { label: "npm ci", shell: process.platform === "win32" });
  }
}

function refuseUncommittedChanges() {
  const status = spawnSync("git", ["status", "--porcelain", "--", "chrome-extension", "shared"], {
    cwd: root,
    encoding: "utf8",
  });
  if (status.status !== 0) throw new Error("Could not run git to check for uncommitted changes.");
  if (status.stdout.trim()) {
    throw new Error(
      "chrome-extension/ or shared/ has uncommitted changes. Commit them first: a published version is never replaced, so it must match the committed code.\n" +
        status.stdout.trim(),
    );
  }
}

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue; // build metadata such as .vite/
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else yield path;
  }
}

function buildZip(version) {
  ensureExtensionDependencies();
  const url = backendUrl();
  console.log(`Building Donna ${version}, default backend ${url ?? "from the extension's own default"}`);

  rmSync(buildDir, { recursive: true, force: true });
  // Run Vite directly (no npm/shell) so this behaves the same on Windows and Linux.
  const vite = join(extensionDir, "node_modules", "vite", "bin", "vite.js");
  run(process.execPath, [vite, "build", "--outDir", buildDir, "--emptyOutDir"], {
    cwd: extensionDir,
    env: { ...process.env, ...(url ? { VITE_DEFAULT_BACKEND_URL: url } : {}) },
    label: "The extension build",
  });

  // Files sit at the zip root, so "Extract All" produces one folder that can be
  // loaded as-is with Chrome's "Load unpacked".
  const entries = {};
  for (const path of files(buildDir)) {
    entries[relative(buildDir, path).split(sep).join("/")] = readFileSync(path);
  }
  if (!entries["manifest.json"]) throw new Error("The build has no manifest.json.");
  const builtVersion = JSON.parse(entries["manifest.json"].toString("utf8")).version;
  if (builtVersion !== version) {
    throw new Error(`Built manifest is ${builtVersion}, expected ${version}.`);
  }
  rmSync(buildDir, { recursive: true, force: true });
  return { bytes: zipSync(entries, { level: 9 }), fileCount: Object.keys(entries).length };
}

async function main() {
  const { version } = JSON.parse(readFileSync(join(extensionDir, "package.json"), "utf8"));

  if (publishing) {
    if (!storageConfigured()) {
      throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to publish the extension.");
    }
    if (await findRelease(version)) {
      console.log(`Donna ${version} is already published (${releasePath(version)}); skipping the extension build.`);
      return;
    }
    if (!onVercel) refuseUncommittedChanges();
  }

  const { bytes, fileCount } = buildZip(version);
  const kb = Math.round(bytes.length / 1024);

  if (publishing) {
    const outcome = await publishRelease(version, bytes);
    console.log(
      outcome === "published"
        ? `Published ${releaseFileName(version)} to ${RELEASE_BUCKET}/${releasePath(version)} (${kb} KB, ${fileCount} files).`
        : `Donna ${version} was published by another build in the meantime; keeping that copy.`,
    );
    return;
  }

  mkdirSync(localDir, { recursive: true });
  const target = join(localDir, releaseFileName(version));
  writeFileSync(target, bytes);
  console.log(`Wrote ${relative(root, target)} (${kb} KB, ${fileCount} files, ${statSync(target).size} bytes). Not uploaded.`);
}

try {
  await main();
} catch (error) {
  console.error(`Could not package the extension: ${error instanceof Error ? error.message : error}`);
  // A broken download must not block a backend deploy. The home page shows the
  // download as unavailable until a version is published.
  process.exitCode = onVercel ? 0 : 1;
}
