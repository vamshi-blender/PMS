<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Live voice AI is out of scope for now

The app has a live voice mode (a realtime spoken conversation with Donna). Nobody is working on it until the main text-chat app is ready, so treat it as if it were not there:

- Skip the voice code when searching or exploring. Do not read it, cite it, or use it as a reference for how something is done.
- Do not mention voice mode in answers, plans, summaries, or caveats, including to say that a change does not cover it.
- Do not change the voice code as part of other work. If a change to shared code cannot compile or pass tests without touching it, make the smallest edit that keeps it building and leave its behavior alone.

The voice code is:

- `app/api/realtime/`
- `chrome-extension/src/realtime/`
- `chrome-extension/src/api/realtime.ts`
- `chrome-extension/src/components/VoiceScreen.*` and `VoiceTranscript.*`
- `tests/voice-session.test.ts`
- the voice wiring inside `chrome-extension/src/components/ChatLayout.tsx` (`useVoiceSession`, `voiceOpen`, `handleOpenVoice`, `handleCloseVoice`, `<VoiceScreen>`) and the voice-mode button in `Composer.tsx`

Dictation is a different feature and stays in scope: the composer's microphone button that records speech and transcribes it into the text box (`app/api/transcriptions/`, `chrome-extension/src/api/transcriptions.ts`).

This applies until the user says voice work has started, or asks about voice directly.

# Extension version number

Colleagues install the extension from a zip offered on the backend's home page, and the version number is how they (and we) tell builds apart. Keep it accurate.

**One source of truth:** the `"version"` field in `chrome-extension/package.json`. The extension manifest, the sidebar footer and the download page all read it. Never write the version anywhere else, and do not hardcode it in `manifest.config.ts`. The `"version"` in the root `package.json` belongs to the backend: leave it alone.

**Format:** `MAJOR.MINOR.PATCH`, digits and dots only (Chrome rejects suffixes such as `-beta`).

**When to bump:** whenever a change alters what ships inside the extension, so people need the new zip to get it. That means changes under `chrome-extension/` (source, `public/`, `manifest.config.ts`, build config) and changes to `shared/` code the extension imports. Bump once per commit or change set meant to be shared, in the same commit as the change.

**When not to bump:** changes that only affect the backend or the repo: `app/`, `lib/`, `supabase/`, `docs/`, `scripts/`, tests, README, and anything else outside the extension's shipped code. A backend-only deploy must keep serving the same extension version.

**Which part to increase:**
- PATCH: bug fixes and small tweaks that change no behavior users would notice by name.
- MINOR: a new or visibly changed user-facing feature.
- MAJOR: a breaking change, such as one that makes older extension builds stop working against the backend (an API or auth contract change). Say so clearly in your summary: colleagues must update immediately.

**Why it matters:** each deploy publishes the extension zip to Supabase Storage as `extension/donna-<version>.zip`, but only if that version is not there yet. A published version is never replaced, and a deploy whose version is unchanged keeps serving the old zip without rebuilding. So extension changes under an unchanged version never reach colleagues, and reusing a version number for different code silently serves the old code.

**How:** change only that one line in `chrome-extension/package.json`, then state the old and new version in your summary. Do not build, zip or publish the extension yourself (no `npm run package:extension -- --publish`) unless the user asks; packaging and publishing happen at deploy time. If you are unsure whether a change warrants a bump or which part to increase, ask the user instead of guessing. Never bump the version for a backend-only change, and never reuse a version number for different extension code.
