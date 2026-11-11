import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../chrome-extension/src/App";
import type { PmsEnvironment } from "../chrome-extension/src/api/pmsEnvironment";

const state = vi.hoisted(() => ({
  selected: "staging" as "staging" | "production",
  logins: { staging: true, production: false },
  auth: vi.fn(), establish: vi.fn(), switch: vi.fn(),
}));
vi.mock("../chrome-extension/src/api/pmsAuth", () => ({ getPmsAuthState: state.auth,
  capturePmsScope: async () => ({ environment: state.selected, userId: "user", organizationId: "org", sessionId: "00000000-0000-4000-8000-000000000001" }),
}));
vi.mock("../chrome-extension/src/api/pmsSession", () => ({
  establishSessionFromCurrentTab: state.establish,
  switchPmsEnvironment: state.switch,
}));
vi.mock("../chrome-extension/src/components/ChatLayout", () => ({
  default: (props: object) => createElement("div", { ...props, "data-testid": "chat" }),
}));
vi.mock("../chrome-extension/src/components/PmsSessionGate", () => ({
  default: (props: object) => createElement("div", { ...props, "data-testid": "gate" }),
}));

let renderer: ReactTestRenderer;
let listener: ((changes: Record<string, { newValue: string }>, area: string) => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  state.selected = "staging";
  state.logins = { staging: true, production: false };
  state.auth.mockReset().mockImplementation(async (env: PmsEnvironment) => state.logins[env] ? { status: "ok", token: "test" } : { status: "logged-out" });
  state.establish.mockReset().mockResolvedValue(undefined);
  state.switch.mockReset().mockImplementation(async (env: PmsEnvironment) => {
    state.selected = env;
    listener?.({ donnaPmsEnvironment: { newValue: env } }, "session");
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { close: vi.fn() });
  vi.stubGlobal("chrome", {
    storage: {
      session: { get: async () => ({ donnaPmsEnvironment: state.selected }), set: async () => {} },
      onChanged: { addListener: (fn: typeof listener) => { listener = fn; }, removeListener: vi.fn() },
    },
    runtime: { onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
  });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  listener = undefined;
  vi.useRealTimers(); vi.unstubAllGlobals();
});
async function mount() { await act(async () => { renderer = create(createElement(App, { ctx: "sidepanel" })); }); }

it("opens the selected chat even when the other environment is logged out", async () => {
  await mount();
  expect(renderer.root.findByProps({ "data-testid": "chat" }).props.environment).toBe("staging");
  expect(state.auth).toHaveBeenCalledWith("production");
});

it("shows the selected environment's login gate and allows switching back to the logged-in chat", async () => {
  await mount();
  await act(async () => renderer.root.findByProps({ "data-testid": "chat" }).props.onEnvironmentChange("production"));
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  const gate = renderer.root.findByProps({ "data-testid": "gate" });
  expect(gate.props.environment).toBe("production");
  expect(gate.props.mode).toBe("gate");
  await act(async () => gate.props.onEnvironmentChange("staging"));
  expect(renderer.root.findByProps({ "data-testid": "chat" }).props.environment).toBe("staging");
});

it("unlocks the selected environment after login without requiring both sessions", async () => {
  state.selected = "production";
  state.logins.staging = false;
  await mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(renderer.root.findByProps({ "data-testid": "gate" }).props.environment).toBe("production");
  state.logins.production = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(renderer.root.findByProps({ "data-testid": "chat" }).props.environment).toBe("production");
});

it("updates an already-open surface when the toolbar selects a different environment", async () => {
  state.logins.production = true;
  await mount();
  await act(async () => { state.selected = "production"; listener?.({ donnaPmsEnvironment: { newValue: "production" } }, "session"); });
  expect(renderer.root.findByProps({ "data-testid": "chat" }).props.environment).toBe("production");
});
