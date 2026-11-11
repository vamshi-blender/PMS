import { ENVIRONMENT_IDS, PMS_ENVIRONMENTS, type PmsEnvironment } from "../api/pmsEnvironment";
import "./EnvironmentOptions.css";

interface EnvironmentOptionsProps {
  environment: PmsEnvironment;
  onChange: (environment: PmsEnvironment) => void;
}

const DESCRIPTIONS: Record<PmsEnvironment, string> = {
  staging: "Safe for testing",
  production: "Live data",
};

export default function EnvironmentOptions({ environment, onChange }: EnvironmentOptionsProps) {
  return (
    <div className="environment-options" role="radiogroup" aria-label="PMS environment">
      <span className="environment-options-title">Environment</span>
      {ENVIRONMENT_IDS.map(value => {
        const selected = value === environment;
        return (
          <button key={value} type="button" role="radio" aria-checked={selected}
            className="environment-option" data-env={value} onClick={() => onChange(value)}>
            <span className="environment-option-text">
              <span className="environment-option-label">{PMS_ENVIRONMENTS[value].label}</span>
              <span className="environment-option-desc">{DESCRIPTIONS[value]}</span>
            </span>
            <svg className="environment-option-check" viewBox="0 0 16 16" width="16" height="16"
              aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round">
              <path d="M3.5 8.5l3 3 6-7" />
            </svg>
          </button>
        );
      })}
    </div>
  );
}
