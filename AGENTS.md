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
