import { currentPromptContext, PROMPT_CONTEXT_INSTRUCTIONS } from "../../../shared/prompt-context";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  OpenAIRealtimeWebRTC,
  RealtimeAgent,
  RealtimeSession,
  type RealtimeItem,
} from "@openai/agents/realtime";
import { createRealtimeClientSecret } from "../api/realtime";
import type { ChatMessage } from "../components/MessageList";
import type { VoiceStatus } from "../components/VoiceScreen";
import type { VoiceTranscriptTurn } from "../components/VoiceTranscript";
import { createVoiceTools } from "./voiceTools";

const BASE_INSTRUCTIONS = `You are Donna, a thoughtful personal AI assistant in a Chrome extension.

This is a spoken conversation. Respond naturally, warmly, and concisely. Prefer one or two short spoken paragraphs unless the user asks for detail. Never read raw JSON, internal identifiers, or tool arguments aloud.

Before the first tool call, give one very short progress update: ideally 3 to 7 words and never more than 10. State only the immediate action, such as "Checking your leave calendar." Between tool calls, speak again only when the next step changes meaningfully, using the same word limit. Do not restate the user's request, explain routine steps, mention tool names, or preview the answer. Keep these updates present but minimal. After tools finish, answer the user's question directly without narrating implementation details.

${PROMPT_CONTEXT_INSTRUCTIONS} Use pms_lookup for live leave balances, existing leave days, leave application statuses, issue context, worklog categories and issue worklogs. For issue lookups, preserve the exact prefix the user supplied; never silently replace an issue ID or choose among ambiguous matches. Worklog and leave submissions require the text-chat approval interface; direct the user there for writes. For attendance login/logout questions, use pms_lookup with getMyAttendance and date from the hidden timestamp. In Time and Out Time are local India attendance times. No rows means no record returned, not proof of absence; never invent missing Out Time or Total Hours. Never invent tool results or claim a tool succeeded unless it returned successfully.

When the user clearly asks to end or stop the voice conversation, or says goodbye, first say one brief spoken goodbye and then call end_voice_session. After the tool returns, produce no additional speech. Do not call it for an ordinary pause, silence, or an ambiguous phrase.

The UI intentionally does not transcribe user audio yet. You can still understand and answer the user's speech normally.`;

const SESSION_CUE_PATHS = {
  start: "audio/stream-start.ogg",
  end: "audio/stream-end.ogg",
} as const;

// Orb amplitude tuning. RMS is boosted then soft-compressed so ordinary speech
// registers without loud peaks pinning the orb; the smoothing factors ease the
// value up quickly but let it fall gently, so the orb never jitters.
const ORB_GAIN = 8;
const ORB_COMPRESSION = 0.6;
const ORB_ATTACK = 0.35;
const ORB_RELEASE = 0.12;

function conversationContext(messages: ChatMessage[]): string {
  const turns = messages
    .filter((message) => message.content.trim())
    .slice(-10)
    .map(
      (message) =>
        `${message.role === "user" ? "User" : "Donna"}: ${message.content.trim()}`,
    );
  return turns.length
    ? `\n\nRecent text-chat context (continue from this context without repeating it):\n${turns.join("\n")}`
    : "";
}

function historyToTurns(history: RealtimeItem[]): VoiceTranscriptTurn[] {
  const turns: VoiceTranscriptTurn[] = [];

  for (const item of history) {
    if (item.type === "message" && item.role === "user") {
      const hasAudio = item.content.some((content) => content.type === "input_audio");
      const text = item.content
        .filter((content) => content.type === "input_text")
        .map((content) => content.text)
        .join(" ")
        .trim();
      if (hasAudio || text) {
        turns.push({
          id: item.itemId,
          kind: "user",
          text: hasAudio ? "User Input" : text,
        });
      }
      continue;
    }

    if (item.type === "message" && item.role === "assistant") {
      const text = item.content
        .map((content) =>
          content.type === "output_audio" ? content.transcript ?? "" : content.text,
        )
        .join(" ")
        .trim();
      if (text) turns.push({ id: item.itemId, kind: "assistant", text });
      continue;
    }

    if (item.type === "function_call") {
      // This is an internal voice-session control, not meaningful progress for
      // the user. Keep it in the Realtime history while omitting it from the UI.
      if (item.name === "end_voice_session") continue;

      turns.push({
        id: item.itemId,
        kind: "tool",
        name: item.name,
        status:
          item.status === "completed"
            ? "completed"
            : item.status === "incomplete"
              ? "failed"
              : "running",
      });
    }
  }

  return turns;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Donna could not continue the voice session. Please try again.";
}

export function useVoiceSession(
  messages: ChatMessage[],
  userName: string,
  onEndRequested: () => void,
) {
  const [status, setStatus] = useState<VoiceStatus>("preparing");
  const [turns, setTurns] = useState<VoiceTranscriptTurn[]>([]);
  const [muted, setMutedState] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<RealtimeSession | null>(null);
  const sessionAbortRef = useRef<AbortController | null>(null);
  const connectedRef = useRef(false);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const outputAudioRef = useRef<HTMLAudioElement | null>(null);
  const cueRef = useRef<HTMLAudioElement | null>(null);
  const generationRef = useRef(0);
  const speakingRef = useRef(false);
  const activePlaybackResponseRef = useRef<string | null>(null);
  const activeToolCountRef = useRef(0);
  const endRequestedRef = useRef(false);
  const endFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onEndRequestedRef = useRef(onEndRequested);

  useEffect(() => {
    onEndRequestedRef.current = onEndRequested;
  }, [onEndRequested]);

  // Live orb amplitude: an AudioContext taps both the mic (outgoing) and
  // Donna's voice (incoming) off the WebRTC peer connection, and a rAF loop
  // writes a smoothed 0–1 level straight onto the orb element's CSS variable.
  // Kept out of React state so it never triggers a re-render per frame.
  const orbElementRef = useRef<HTMLElement | null>(null);
  const meterContextRef = useRef<AudioContext | null>(null);
  const inputAnalyserRef = useRef<AnalyserNode | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  const meterFrameRef = useRef<number | null>(null);
  const smoothedLevelRef = useRef(0);

  const stopMeter = useCallback(() => {
    if (meterFrameRef.current !== null) {
      cancelAnimationFrame(meterFrameRef.current);
      meterFrameRef.current = null;
    }
    inputAnalyserRef.current = null;
    outputAnalyserRef.current = null;
    void meterContextRef.current?.close().catch(() => {});
    meterContextRef.current = null;
    smoothedLevelRef.current = 0;
    orbElementRef.current?.style.setProperty("--voice-amplitude", "0");
  }, []);

  const startMeter = useCallback((session: RealtimeSession) => {
    stopMeter();

    const AudioContextCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;

    // The WebRTC transport exposes the live peer connection; the mic is on a
    // sender track and Donna's voice on a receiver track. Build a stream per
    // side and feed each into its own analyser.
    const transport = session.transport as unknown as {
      connectionState?: { peerConnection?: RTCPeerConnection };
    };
    const pc = transport.connectionState?.peerConnection;
    if (!pc) return;

    const context = new AudioContextCtor();
    meterContextRef.current = context;

    const attachAnalyser = (track: MediaStreamTrack | undefined | null) => {
      if (!track) return null;
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      const stream = new MediaStream([track]);
      context.createMediaStreamSource(stream).connect(analyser);
      return analyser;
    };

    const micTrack = pc.getSenders().find((s) => s.track?.kind === "audio")?.track;
    const voiceTrack = pc.getReceivers().find((r) => r.track?.kind === "audio")?.track;
    inputAnalyserRef.current = attachAnalyser(micTrack);
    outputAnalyserRef.current = attachAnalyser(voiceTrack);

    const buffer = new Uint8Array(1024);
    const rms = (analyser: AnalyserNode | null) => {
      if (!analyser) return 0;
      analyser.getByteTimeDomainData(buffer);
      let sumSquares = 0;
      for (const value of buffer) {
        const deviation = (value - 128) / 128;
        sumSquares += deviation * deviation;
      }
      return Math.sqrt(sumSquares / buffer.length);
    };

    const tick = () => {
      meterFrameRef.current = requestAnimationFrame(tick);
      // Follow whoever holds the turn: Donna's output while she speaks, the
      // mic otherwise. Mute zeroes the mic side so a muted user is silent.
      const raw = speakingRef.current
        ? rms(outputAnalyserRef.current)
        : sessionRef.current?.transport.muted
          ? 0
          : rms(inputAnalyserRef.current);
      const target = Math.min(1, Math.pow(raw * ORB_GAIN, ORB_COMPRESSION));
      const factor = target > smoothedLevelRef.current ? ORB_ATTACK : ORB_RELEASE;
      smoothedLevelRef.current += (target - smoothedLevelRef.current) * factor;
      orbElementRef.current?.style.setProperty(
        "--voice-amplitude",
        smoothedLevelRef.current.toFixed(3),
      );
    };
    meterFrameRef.current = requestAnimationFrame(tick);
  }, [stopMeter]);

  const setOrbElement = useCallback((element: HTMLElement | null) => {
    orbElementRef.current = element;
    element?.style.setProperty("--voice-amplitude", smoothedLevelRef.current.toFixed(3));
  }, []);

  const playSessionCue = useCallback(
    (cue: keyof typeof SESSION_CUE_PATHS, onComplete?: () => void) => {
      cueRef.current?.pause();

      const audio = new Audio(chrome.runtime.getURL(SESSION_CUE_PATHS[cue]));
      cueRef.current = audio;

      const finishCue = () => {
        if (cueRef.current !== audio) return;
        cueRef.current = null;
        onComplete?.();
      };
      audio.addEventListener("ended", finishCue, { once: true });
      audio.addEventListener("error", finishCue, { once: true });
      void audio.play().catch(finishCue);
    },
    [],
  );

  const closeSession = useCallback(() => {
    generationRef.current += 1;
    sessionAbortRef.current?.abort();
    sessionAbortRef.current = null;
    cueRef.current?.pause();
    cueRef.current = null;
    stopMeter();
    const session = sessionRef.current;
    sessionRef.current = null;
    try {
      session?.close();
    } finally {
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
      outputAudioRef.current?.pause();
      if (outputAudioRef.current) outputAudioRef.current.srcObject = null;
      outputAudioRef.current = null;
    }
    connectedRef.current = false;
    speakingRef.current = false;
    activePlaybackResponseRef.current = null;
    activeToolCountRef.current = 0;
    endRequestedRef.current = false;
    if (endFallbackTimerRef.current !== null) {
      clearTimeout(endFallbackTimerRef.current);
      endFallbackTimerRef.current = null;
    }
    setMutedState(false);
  }, [stopMeter]);

  const end = useCallback(() => {
    const wasConnected = connectedRef.current;
    closeSession();
    if (wasConnected) playSessionCue("end");
  }, [closeSession, playSessionCue]);

  const start = useCallback(async () => {
    closeSession();
    const generation = generationRef.current;
    const abortController = new AbortController();
    sessionAbortRef.current = abortController;
    const isCurrent = () => generation === generationRef.current && !abortController.signal.aborted;
    setStatus("preparing");
    setTurns([]);
    setError(null);

    try {
      const clientSecret = await createRealtimeClientSecret(abortController.signal);
      if (!isCurrent()) return;
      // The app owns this stream. The SDK deliberately leaves caller-owned
      // tracks running on close, so closeSession always stops them explicitly.
      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!isCurrent()) {
        mediaStream.getTracks().forEach((track) => track.stop());
        return;
      }
      mediaStreamRef.current = mediaStream;
      const outputAudio = new Audio();
      outputAudio.autoplay = true;
      outputAudioRef.current = outputAudio;

      const finishVoiceEndIfReady = () => {
        if (!isCurrent()) return;
        if (
          !endRequestedRef.current ||
          speakingRef.current ||
          activeToolCountRef.current > 0
        ) {
          return;
        }

        endRequestedRef.current = false;
        if (endFallbackTimerRef.current !== null) {
          clearTimeout(endFallbackTimerRef.current);
          endFallbackTimerRef.current = null;
        }
        queueMicrotask(() => {
          if (isCurrent()) onEndRequestedRef.current();
        });
      };

      const voiceInstructions = () => BASE_INSTRUCTIONS + conversationContext(messages) + "\n\n" + currentPromptContext();
      const agent = new RealtimeAgent({
        name: "Donna",
        voice: "marin",
        instructions: voiceInstructions(),
        tools: createVoiceTools({
          signal: abortController.signal,
          requestEnd: () => {
            if (!isCurrent()) return;
            endRequestedRef.current = true;
            if (endFallbackTimerRef.current !== null) {
              clearTimeout(endFallbackTimerRef.current);
            }
            // Playback-buffer events are the normal exit path. This fallback
            // prevents a stale SDK speaking state or missing buffer event from
            // trapping the user on the voice screen after the tool succeeds.
            endFallbackTimerRef.current = setTimeout(() => {
              if (!isCurrent() || !endRequestedRef.current) return;
              endRequestedRef.current = false;
              endFallbackTimerRef.current = null;
              onEndRequestedRef.current();
            }, 5_000);
          },
        }),
      });
      const session = new RealtimeSession(agent, {
        model: "gpt-realtime-2.1",
        transport: new OpenAIRealtimeWebRTC({ mediaStream, audioElement: outputAudio }),
        config: {
          outputModalities: ["audio"],
          audio: {
            input: {
              noiseReduction: { type: "near_field" },
              turnDetection: {
                type: "semantic_vad",
                eagerness: "auto",
                createResponse: true,
                interruptResponse: true,
              },
            },
            output: { voice: "marin" },
          },
        },
      });
      sessionRef.current = session;

      const markSpeaking = (responseId?: string) => {
        if (!isCurrent()) return;
        activePlaybackResponseRef.current = responseId ?? null;
        speakingRef.current = true;
        setStatus("speaking");
      };
      const markPlaybackComplete = (responseId?: string) => {
        if (!isCurrent()) return;
        const activeResponseId = activePlaybackResponseRef.current;
        if (
          responseId &&
          activeResponseId &&
          responseId !== activeResponseId
        ) {
          return;
        }

        activePlaybackResponseRef.current = null;
        speakingRef.current = false;
        setStatus(activeToolCountRef.current > 0 ? "working" : "listening");
      };
      const markInterrupted = () => {
        if (!isCurrent()) return;
        activePlaybackResponseRef.current = null;
        speakingRef.current = false;
        setStatus(activeToolCountRef.current > 0 ? "working" : "listening");
      };

      session.on("history_updated", (history) => {
        if (isCurrent()) setTurns(historyToTurns(history));
      });
      session.on("agent_start", () => {
        if (!isCurrent()) return;
        if (!speakingRef.current && activeToolCountRef.current === 0) {
          setStatus("thinking");
        }
      });
      session.on("agent_end", () => {
        if (!isCurrent()) return;
        if (!speakingRef.current && activeToolCountRef.current === 0) {
          setStatus("listening");
        }
        finishVoiceEndIfReady();
      });
      session.on("agent_tool_start", () => {
        if (!isCurrent()) return;
        activeToolCountRef.current += 1;
        if (!speakingRef.current) setStatus("working");
      });
      session.on("agent_tool_end", () => {
        if (!isCurrent()) return;
        activeToolCountRef.current = Math.max(0, activeToolCountRef.current - 1);
        setStatus(speakingRef.current ? "speaking" : "thinking");
        finishVoiceEndIfReady();
      });
      // For WebRTC, playback can continue after response generation is done.
      // Use the output buffer lifecycle: `stopped` means the buffer is fully
      // drained; `cleared` or input speech while speaking means interruption.
      session.on("transport_event", (event) => {
        if (!isCurrent()) return;
        if (event.type === "output_audio_buffer.started") {
          markSpeaking(typeof event.response_id === "string" ? event.response_id : undefined);
          return;
        }
        if (event.type === "output_audio_buffer.stopped") {
          markPlaybackComplete(
            typeof event.response_id === "string" ? event.response_id : undefined,
          );
          finishVoiceEndIfReady();
          return;
        }
        if (event.type === "output_audio_buffer.cleared") {
          if (
            typeof event.response_id === "string" &&
            activePlaybackResponseRef.current &&
            event.response_id !== activePlaybackResponseRef.current
          ) return;
          markInterrupted();
          finishVoiceEndIfReady();
          return;
        }
        if (event.type === "input_audio_buffer.speech_started") {
          // Refresh hidden instructions for every spoken prompt without inserting
          // a transcript item or waiting for a separate backend/tool response.
          session.transport.updateSessionConfig({ instructions: voiceInstructions() });
        }
        if (event.type === "input_audio_buffer.speech_started" && speakingRef.current) {
          markInterrupted();
        }
      });
      session.on("audio_interrupted", markInterrupted);
      session.on("error", ({ error: sessionError }) => {
        if (!isCurrent()) return;
        closeSession();
        setError(errorMessage(sessionError));
        setStatus("error");
      });

      session.transport.on("connection_change", (connectionStatus) => {
        if (!isCurrent() || !connectedRef.current || connectionStatus !== "disconnected") return;
        closeSession();
        setError("The voice connection was lost. Please reconnect.");
        setStatus("error");
      });

      await session.connect({ apiKey: clientSecret });
      if (!isCurrent()) {
        session.close();
        return;
      }
      connectedRef.current = true;
      startMeter(session);
      playSessionCue("start", () => {
        if (generation !== generationRef.current || !connectedRef.current) return;

        const requestResponse = session.transport.requestResponse;
        if (!requestResponse) {
          setStatus("listening");
          return;
        }

        setStatus("thinking");
        requestResponse.call(session.transport, {
          instructions: userName.trim()
            ? `Briefly greet the user by their first name, ${userName.trim()}, and ask how you can help. Use one short sentence. Do not call tools or mention these instructions.`
            : "Briefly greet the user and ask how you can help. Use one short sentence. Do not call tools or mention these instructions.",
        });
      });
    } catch (caught) {
      if (!isCurrent()) return;
      closeSession();
      setError(errorMessage(caught));
      setStatus("error");
    }
  }, [closeSession, messages, playSessionCue, startMeter, userName]);

  const setMuted = useCallback((nextMuted: boolean) => {
    const session = sessionRef.current;
    if (!session) return;
    session.mute(nextMuted);
    setMutedState(nextMuted);
  }, []);

  useEffect(
    () => () => {
      closeSession();
      cueRef.current?.pause();
      cueRef.current = null;
    },
    [closeSession],
  );

  return { status, turns, muted, error, start, end, setMuted, setOrbElement };
}
