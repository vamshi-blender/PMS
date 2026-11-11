import { useEffect, useRef, useState } from "react";
import type { DisplayMode } from "./mode";
import ChatLayout from "./components/ChatLayout";
import PmsSessionGate from "./components/PmsSessionGate";
import { capturePmsScope, getPmsAuthState } from "./api/pmsAuth";
import { ENVIRONMENT_IDS, ENVIRONMENT_KEY, PMS_SESSION_KEY, getSelectedEnvironment, type PmsEnvironment } from "./api/pmsEnvironment";
import { establishSessionFromCurrentTab, switchPmsEnvironment } from "./api/pmsSession";

// How often the PMS session is re-checked once settled (steady-state poll).
// The same poll flips the UI both ways: gate → chat on login, chat → gate on
// logout. The check reads the token fresh from the PMS tab each time.
const AUTH_POLL_MS = 4000;

// While unauthenticated, PMS can take a few seconds to finish its own
// client-side bootstrap and write its session into localStorage — well after
// the tab itself reports "complete". Rather than judge the user logged-out
// on the first miss, keep polling quickly and hold the spinner up to this
// long before conceding to the login gate. Tune this one number to change
// how long the grace period lasts.
const AUTH_GRACE_MS = 3_000;
const AUTH_GRACE_POLL_MS = 800;

type AuthPhase = "checking" | "authed" | "gate";

interface AppProps {
  ctx: DisplayMode;
}

export default function App({ ctx }: AppProps) {
  const [phase, setPhase] = useState<AuthPhase>("checking");
  const [environment, setEnvironment] = useState<PmsEnvironment | null>(null);
  const [userKey, setUserKey] = useState("");
  const authenticatedRef = useRef(false);
  const [switchError, setSwitchError] = useState("");
  const switchingRef = useRef(false);
  const initializedRef = useRef(false);
  const graceDeadlineRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Pop-out toolbar handling already established the group in the worker.
    // Side panels and action popups establish it here, before auth polling.
    const ready = ctx === "popout" ? Promise.resolve() : establishSessionFromCurrentTab();
    void ready.then(getSelectedEnvironment).then(value => {
      if (!cancelled) { initializedRef.current = true; setEnvironment(value); }
    }).catch(error => {
      if (!cancelled) {
        setSwitchError(error instanceof Error ? error.message : "Could not open PMS.");
        setPhase("gate");
      }
    });
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      const value = changes[ENVIRONMENT_KEY]?.newValue;
      if (!initializedRef.current || area !== "session" || (value !== "staging" && value !== "production")) return;
      setPhase("checking");
      graceDeadlineRef.current = null;
      setEnvironment(value);
    };
    chrome.storage.onChanged.addListener(changed);
    return () => { cancelled = true; chrome.storage.onChanged.removeListener(changed); };
  }, [ctx]);

  async function changeEnvironment(next: PmsEnvironment) {
    if (next === environment || switchingRef.current) return;
    switchingRef.current = true;
    setSwitchError("");
    setPhase("checking");
    try {
      await switchPmsEnvironment(next);
      graceDeadlineRef.current = null;
      setEnvironment(next);
    } catch (error) {
      setSwitchError(error instanceof Error ? error.message : "Could not switch PMS environment.");
      setPhase("gate");
    } finally { switchingRef.current = false; }
  }

  useEffect(() => {
    if (!environment) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const scheduleNext = (delay: number) => {
      if (cancelled) return;
      timer = setTimeout(() => void check(), delay);
    };

    const check = async () => {
      // Each login is independent; neither environment requires the other.
      const states = await Promise.all(ENVIRONMENT_IDS.map(env => getPmsAuthState(env)));
      const state = states[ENVIRONMENT_IDS.indexOf(environment)];
      if (cancelled) return;
      if (switchingRef.current) { scheduleNext(AUTH_GRACE_POLL_MS); return; }

      if (state.status === "ok") {
        try {
          const scope = await capturePmsScope();
          if (cancelled || scope.environment !== environment) return;
          const nextUser = `${scope.organizationId}:${scope.userId}`;
          setUserKey(`${nextUser}:${scope.sessionId}`);
          authenticatedRef.current = true;
        } catch {
          if (!cancelled) { setPhase("gate"); scheduleNext(AUTH_POLL_MS); }
          return;
        }
        graceDeadlineRef.current = null;
        setPhase("authed");
        scheduleNext(AUTH_POLL_MS);
        return;
      }

      if (authenticatedRef.current) {
        authenticatedRef.current = false;
        await chrome.storage.session.set({ [PMS_SESSION_KEY]: crypto.randomUUID() });
        if (cancelled) return;
      }

      // Not authed yet. "no-tab" (no PMS tab exists at all) has nothing to
      // wait on, so it goes straight to the gate; "logged-out"/"loading"
      // both get the grace window, since a fresh tab briefly reads as
      // logged-out before its session is written.
      if (state.status === "no-tab") {
        graceDeadlineRef.current = null;
        setPhase("gate");
        scheduleNext(AUTH_POLL_MS);
        return;
      }

      const deadline = (graceDeadlineRef.current ??= Date.now() + AUTH_GRACE_MS);
      if (Date.now() < deadline) {
        setPhase("checking");
        scheduleNext(AUTH_GRACE_POLL_MS);
      } else {
        setPhase("gate");
        scheduleNext(AUTH_POLL_MS);
      }
    };

    void check();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [environment]);

  // The background worker broadcasts this once the session's tab group is
  // gone (closed, ungrouped, or its PMS tab removed) — there is no longer a
  // tab group for the extension to operate on, so the surface closes itself.
  useEffect(() => {
    function handleMessage(message: unknown) {
      if ((message as { type?: string } | undefined)?.type === "session-ended") {
        window.close();
      }
    }
    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, []);

  if (phase === "authed" && environment) return <ChatLayout key={`${environment}:${userKey}`} ctx={ctx} environment={environment} onEnvironmentChange={changeEnvironment} />;
  return <PmsSessionGate environment={environment ?? "staging"} onEnvironmentChange={changeEnvironment} error={switchError} mode={phase === "checking" ? "checking" : "gate"} />;
}
