// Builds the Chrome extension and zips it to public/donna-extension.zip, which
// the home page offers for download. Runs on Vercel before `next build` (see
// vercel.json), so the zip always matches the deployed backend.
//
//   npm run package:extension
//
// Backend the packaged build talks to by default: the extension's own default
// (https://worklogs-wheat.vercel.app, see chrome-extension/src/api/backend.ts),
// unless DONNA_BACKEND_URL is set to override it.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = join(root, "chrome-extension");
const buildDir = join(extensionDir, "dist-package");
const zipPath = join(root, "public", "donna-extension.zip");

function backendUrl() {
  const explicit = process.env.DONNA_BACKEND_URL?.trim();
  return explicit ? new URL(explicit).origin : undefined;
}

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue; // build metadata such as .vite/
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else yield path;
  }
}

function build() {
  const url = backendUrl();
  const { version } = JSON.parse(readFileSync(join(extensionDir, "package.json"), "utf8"));
  console.log(`Packaging Donna ${version}, default backend ${url ?? "from the extension's own default"}`);

  rmSync(buildDir, { recursive: true, force: true });
  // Run Vite directly (no npm/shell) so this behaves the same on Windows and Linux.
  const vite = join(extensionDir, "node_modules", "vite", "bin", "vite.js");
  const result = spawnSync(process.execPath, [vite, "build", "--outDir", buildDir, "--emptyOutDir"], {
    cwd: extensionDir,
    stdio: "inherit",
    env: { ...process.env, ...(url ? { VITE_DEFAULT_BACKEND_URL: url } : {}) },
  });
  if (result.status !== 0) throw new Error("The extension build failed.");

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

  mkdirSync(dirname(zipPath), { recursive: true });
  writeFileSync(zipPath, zipSync(entries, { level: 9 }));
  rmSync(buildDir, { recursive: true, force: true });
  console.log(`Wrote ${relative(root, zipPath)} (${Math.round(statSync(zipPath).size / 1024)} KB, ${Object.keys(entries).length} files)`);
}

try {
  build();
} catch (error) {
  console.error(`Could not package the extension: ${error instanceof Error ? error.message : error}`);
  // A broken download page must not block a backend deploy. The home page
  // shows the download as unavailable when the zip is missing.
  rmSync(zipPath, { force: true });
  process.exitCode = process.env.VERCEL ? 0 : 1;
}
