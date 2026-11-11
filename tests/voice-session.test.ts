import { createElement, useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EventEmitter } from "node:events";
import { useVoiceSession } from "../chrome-extension/src/realtime/useVoiceSession";

type FakeSession = EventEmitter & {
  transport: EventEmitter;
  close: ReturnType<typeof vi.fn>;
};
const sdk = vi.hoisted(() => ({
  sessions: [] as FakeSession[],
  connect: vi.fn<() => Promise<void>>(),
  createSecret: vi.fn(),
}));
vi.mock("@openai/agents/realtime", async () => {
  const { EventEmitter } = await import("node:events");
  class Transport extends EventEmitter {
    requestResponse = vi.fn();
  }
  return {
    RealtimeAgent: class {},
    OpenAIRealtimeWebRTC: Transport,
    RealtimeSession: class extends EventEmitter {
      transport: Transport;
      constructor(_agent: unknown, options: { transport: Transport }) {
        super();
        this.transport = options.transport;
        sdk.sessions.push(this);
      }
      connect = () => sdk.connect();
      close = vi.fn(() => this.transport.emit("connection_change", "disconnected"));
      mute = vi.fn();
    },
  };
});
vi.mock("../chrome-extension/src/api/realtime", () => ({
  createRealtimeClientSecret: sdk.createSecret,
}));
vi.mock("../chrome-extension/src/realtime/voiceTools", () => ({ createVoiceTools: () => [] }));
vi.mock("../chrome-extension/src/api/pmsAuth", () => ({ assertPmsScope: async () => "token", capturePmsScope: async () => ({
  environment: "staging", userId: "user", organizationId: "org", sessionId: "00000000-0000-4000-8000-000000000001",
}) }));

let hook: ReturnType<typeof useVoiceSession>;
let renderer: ReactTestRenderer;
let track: { stop: ReturnType<typeof vi.fn> };
const onEnd = vi.fn();
const messages: never[] = [];
function Harness() {
  const value = useVoiceSession(messages, "", onEnd);
  useEffect(() => { hook = value; }, [value]);
  return null;
}

beforeEach(async () => {
  sdk.sessions.length = 0;
  sdk.connect.mockReset().mockResolvedValue();
  sdk.createSecret.mockReset().mockResolvedValue("ephemeral-test");
  onEnd.mockReset();
  track = { stop: vi.fn() };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [track] }) },
  });
  vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => path } });
  vi.stubGlobal("Audio", class {
    srcObject = null;
    autoplay = false;
    pause = vi.fn();
    play = () => Promise.resolve();
    addEventListener = vi.fn();
  });
  await act(async () => { renderer = create(createElement(Harness)); });
});

afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});

it("releases the app-owned microphone and closes transport on end", async () => {
  await act(async () => hook.start());
  await act(async () => hook.end());
  expect(track.stop).toHaveBeenCalledTimes(1);
  expect(sdk.sessions[0].close).toHaveBeenCalledTimes(1);
});

it("stops a microphone granted after the user has already ended the session", async () => {
  let grant!: (value: MediaStream | PromiseLike<MediaStream>) => void;
  vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(() => new Promise((resolve) => {
    grant = resolve;
  }));
  let starting!: Promise<void>;
  await act(async () => { starting = hook.start(); });
  await act(async () => hook.end());
  await act(async () => {
    grant({ getTracks: () => [track] } as unknown as MediaStream);
    await starting;
  });
  expect(track.stop).toHaveBeenCalledTimes(1);
  expect(sdk.sessions).toHaveLength(0);
});

it("ignores events from an old session after reconnecting", async () => {
  await act(async () => hook.start());
  const old = sdk.sessions[0];
  await act(async () => hook.start());
  const current = sdk.sessions[1];
  await act(async () => {
    current.emit("transport_event", { type: "output_audio_buffer.started", response_id: "new" });
    old.emit("transport_event", { type: "output_audio_buffer.stopped", response_id: "old" });
    old.emit("agent_end");
    old.emit("error", { error: new Error("Stale error") });
  });
  expect(hook.status).toBe("speaking");
  expect(hook.error).toBeNull();
  expect(current.close).not.toHaveBeenCalled();
  expect(onEnd).not.toHaveBeenCalled();
});

it("cleans up microphone and enters error state when the active connection drops", async () => {
  await act(async () => hook.start());
  await act(async () => { sdk.sessions[0].transport.emit("connection_change", "disconnected"); });
  expect(track.stop).toHaveBeenCalledTimes(1);
  expect(hook.status).toBe("error");
  expect(hook.error).toContain("connection was lost");
});

it("ignores playback completion from an older response in the same session", async () => {
  await act(async () => hook.start());
  await act(async () => {
    sdk.sessions[0].emit("transport_event", { type: "output_audio_buffer.started", response_id: "new" });
    sdk.sessions[0].emit("transport_event", { type: "output_audio_buffer.stopped", response_id: "old" });
    sdk.sessions[0].emit("transport_event", { type: "output_audio_buffer.cleared", response_id: "old" });
  });
  expect(hook.status).toBe("speaking");
});
