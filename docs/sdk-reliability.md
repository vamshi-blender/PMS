# Donna SDK lifecycle behavior

Browser tool approvals are claimed through `POST /api/chat/claim` before the
extension executes the tool. Expired approvals and competing claims fail before
execution. The returned `claimId` accompanies the result sent to
`POST /api/chat/resume`. Rejections that have not started execution need no claim.
A claim is single-use and is not automatically released or retried after a
transport failure, because a submitted PMS action may already have succeeded.
Deploy the backend and reload the rebuilt extension together for this protocol.

Resume validates the result and interruption before consuming the checkpoint.
It prefers the live SDK state, preserves earlier browser tool results, and uses
serialized state as a fallback. Alternative instructions enter the resumed run as
user input through `RunState.addInput()`.

One abort signal covers a chat's stream, automatic browser tools, manual approvals,
PMS requests, and subsequent resumes. Stop prevents further continuation and
aborts in-flight HTTP requests. Cancellation cannot undo a PMS action that the
remote server has already accepted. Malformed and truncated response streams
produce an error instead of leaving the chat waiting.

Voice sessions own their microphone stream and stop its tracks on end, failure,
disconnect, and unmount. A late microphone permission result is also released.
Session generation checks ignore callbacks from previous connections. Closing a
session also aborts its tool requests, clears its cues and timers, and releases
the audio meter and playback element.

Checkpoints remain in process memory for ten minutes. They are shared by routes
within one server process; they do not survive restarts or span multiple replicas.
Shared durable storage and distributed claims are needed before scaling this
mechanism across server instances.

## Validation

Install dependencies in the root and `chrome-extension` directories, then run:

```powershell
npm test
npm run test:types
npm run lint
npm run build
npx tsc --noEmit --project chrome-extension/tsconfig.json
npm run build --prefix chrome-extension
```

Regression tests exercise the actual SDK runner with `ScriptedModel`, approval
routes, stream cancellation, browser-tool cancellation, and voice hook lifecycle
races. They make no live OpenAI or PMS calls. A live extension check is still
needed for microphone permissions, audio playback, barge-in, and PMS submission.
