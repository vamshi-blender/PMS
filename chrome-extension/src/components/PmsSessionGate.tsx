import { HugeiconsIcon } from "@hugeicons/react";
import { SquareLock02Icon } from "@hugeicons/core-free-icons";
import { focusPmsTab } from "../api/pmsAuth";
import { PMS_ENVIRONMENTS, type PmsEnvironment } from "../api/pmsEnvironment";
import EnvironmentOptions from "./EnvironmentOptions";
import "./PmsSessionGate.css";

interface PmsSessionGateProps {
  // "checking": still within the grace window, waiting for PMS to finish
  // loading its session — shows a spinner, no action for the user to take.
  // "gate": grace window expired with no session found — shows the same
  // shell with a "Go to PMS" action. One component, one continuous screen.
  mode: "checking" | "gate";
  environment: PmsEnvironment;
  onEnvironmentChange: (environment: PmsEnvironment) => void;
  error?: string;
}

export default function PmsSessionGate({ mode, environment, onEnvironmentChange, error }: PmsSessionGateProps) {
  const checking = mode === "checking";

  return (
    <div className="pms-gate">
      <div className="pms-gate-icon" aria-hidden="true">
        {checking ? (
          <span className="pms-gate-spinner" />
        ) : (
          <HugeiconsIcon icon={SquareLock02Icon} size={26} strokeWidth={1.6} />
        )}
      </div>
      <h1 className="pms-gate-title">
        {checking ? "Connecting to PMS…" : "Log in to PMS"}
      </h1>
      <p className="pms-gate-text">
        {checking
          ? "Waiting for your Quixy PMS session to load."
          : "Donna works with your Quixy PMS session. Log in to PMS in your browser to start chatting."}
      </p>
      <p className="pms-gate-hint">{PMS_ENVIRONMENTS[environment].label} PMS</p>
      <EnvironmentOptions environment={environment} onChange={onEnvironmentChange} />
      {error && <p className="pms-gate-text" role="alert">{error}</p>}
      {!checking && (
        <>
          <button
            type="button"
            className="pms-gate-button"
            onClick={() => void focusPmsTab(environment)}
          >
            Go to PMS
          </button>
          <p className="pms-gate-hint">
            Donna unlocks automatically once you&apos;re logged in.
          </p>
        </>
      )}
    </div>
  );
}
