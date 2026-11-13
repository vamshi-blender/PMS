import { statSync } from "node:fs";
import { join } from "node:path";
import extensionPackage from "../chrome-extension/package.json";

const ZIP_FILE = "donna-extension.zip";

// The zip is built into public/ before `next build` (scripts/package-extension.mjs).
// Missing, e.g. in local dev before packaging, is shown instead of a dead link.
function extensionZipSize(): number | null {
  try {
    return statSync(join(process.cwd(), "public", ZIP_FILE)).size;
  } catch {
    return null;
  }
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const INSTALL_STEPS = [
  "Unzip the download into a folder you will keep, such as Documents\\Donna.",
  <>
    In Chrome, open <code>chrome://extensions</code> and switch on <strong>Developer mode</strong> (top right).
  </>,
  <>
    Click <strong>Load unpacked</strong> and choose the folder you unzipped.
  </>,
  "Sign in to PMS in a tab, then open Donna from the Chrome toolbar (or press Ctrl+Shift+Y).",
];

const UPDATE_STEPS = [
  "Download the new zip and unzip it over the same folder, replacing the files.",
  <>
    On <code>chrome://extensions</code>, click the reload icon on the Donna card.
  </>,
  "The version under your name in Donna's sidebar should now match the one on this page.",
];

export default function Home() {
  const { version } = extensionPackage;
  const size = extensionZipSize();

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-10 px-6 py-16 sm:py-24">
      <header className="flex flex-col gap-3">
        <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Chrome extension</p>
        <h1 className="text-4xl font-semibold tracking-tight">Donna</h1>
        <p className="text-lg leading-8 text-zinc-600 dark:text-zinc-400">
          Your PMS assistant, one click away in Chrome. Install it once, sign in to PMS as usual, and
          ask Donna to log work, check leave, or update issues.
        </p>
      </header>

      <section
        aria-labelledby="download-heading"
        className="flex flex-col gap-4 rounded-2xl border border-black/10 p-6 dark:border-white/15"
      >
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="download-heading" className="text-xl font-semibold">
            Download
          </h2>
          <span className="rounded-full bg-black/5 px-3 py-1 text-sm font-medium tabular-nums dark:bg-white/10">
            Version {version}
          </span>
        </div>

        {size === null ? (
          <p role="status" className="text-zinc-600 dark:text-zinc-400">
            The download is not available on this server right now. Ask the team to redeploy.
          </p>
        ) : (
          <>
            <a
              href={`/${ZIP_FILE}`}
              download={`donna-${version}.zip`}
              className="inline-flex h-12 items-center justify-center rounded-full bg-foreground px-6 font-medium text-background transition-opacity hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
            >
              Download Donna {version}
            </a>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              donna-{version}.zip · {formatSize(size)} · Chrome on desktop
            </p>
          </>
        )}
      </section>

      <section aria-labelledby="install-heading" className="flex flex-col gap-3">
        <h2 id="install-heading" className="text-xl font-semibold">
          Install
        </h2>
        <ol className="flex list-decimal flex-col gap-2 pl-6 leading-7 marker:text-zinc-500">
          {INSTALL_STEPS.map((step, index) => (
            <li key={index}>{step}</li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="update-heading" className="flex flex-col gap-3">
        <h2 id="update-heading" className="text-xl font-semibold">
          Update
        </h2>
        <ol className="flex list-decimal flex-col gap-2 pl-6 leading-7 marker:text-zinc-500">
          {UPDATE_STEPS.map((step, index) => (
            <li key={index}>{step}</li>
          ))}
        </ol>
        <p className="text-sm leading-6 text-zinc-500 dark:text-zinc-400">
          Always reuse the same folder. Chrome ties your saved chats and settings to the folder
          location, so loading the update from a new folder starts you with a fresh Donna.
        </p>
      </section>
    </main>
  );
}
