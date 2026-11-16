# pms

Next.js web app with a companion Chrome extension ("Donna") in [chrome-extension/](chrome-extension/).

## Web app

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Chrome extension (Donna)

React + Vite + [@crxjs/vite-plugin](https://crxjs.dev), in its own package under `chrome-extension/`. Runs as a popup, side panel, or floating pop-out window — switchable from inside the extension.

### Build

```bash
cd chrome-extension
npm install
npm run build
```

Output goes to `chrome-extension/dist/`.

### Load into Chrome

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select `chrome-extension/dist`
4. After any rebuild, click the refresh icon on the extension's card

### Sharing the extension

The home page of the deployed backend offers the extension as a zip, with its version number. The zips are stored in Supabase Storage (private bucket `donna-files`, object `extension/donna-<version>.zip`), one immutable file per version. `/donna-extension.zip` is the stable download link: it redirects to a one-minute signed link for the current version.

Every deploy runs `npm run build:vercel` (`vercel.json`), which calls `scripts/package-extension.mjs` before `next build`:

- **Version already published:** nothing happens. The extension is not installed or built, and the same zip keeps being served, so backend-only deploys stay fast.
- **New version:** the script installs the extension's dependencies, builds it, zips it and uploads it. A version is never overwritten.
- **Needs** `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the Vercel environment (the same variables the memory and skills features use). If packaging or the upload fails, the deploy still succeeds and the home page says the download is unavailable.

- **Release a new version:** change `version` in `chrome-extension/package.json` (digits and dots only, e.g. `1.1.0`) and deploy. The manifest, the sidebar and the download page all read that one number. When to bump is described in `AGENTS.md`.
- **Default backend:** the extension talks to `https://worklogs-wheat.vercel.app` unless the user changes it in the sidebar. To develop against a local server, set the backend to `http://localhost:3000` in the sidebar, or build with `VITE_DEFAULT_BACKEND_URL=http://localhost:3000`. `DONNA_BACKEND_URL` overrides the default of the packaged zip.
- **Try it locally:** `npm run package:extension` builds the zip into `.extension-release/` (git-ignored) without uploading. `npm run package:extension -- --publish` also uploads it (it reads `.env.local`, and refuses while `chrome-extension/` or `shared/` has uncommitted changes, because a published version is never replaced).

### Development

```bash
cd chrome-extension
npm run dev
```

Runs Vite with HMR and writes to `dist/` too — load it the same way as above; changes apply live without a manual rebuild, as long as this command keeps running.

**`dev` vs `build`:** both write to `dist/`, so only one should be active at a time. If you switch from one to the other, stop the running command, delete `dist/`, run the other, then reload the extension.
