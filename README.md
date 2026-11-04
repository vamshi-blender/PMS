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

### Development

```bash
cd chrome-extension
npm run dev
```

Runs Vite with HMR and writes to `dist/` too — load it the same way as above; changes apply live without a manual rebuild, as long as this command keeps running.

**`dev` vs `build`:** both write to `dist/`, so only one should be active at a time. If you switch from one to the other, stop the running command, delete `dist/`, run the other, then reload the extension.
