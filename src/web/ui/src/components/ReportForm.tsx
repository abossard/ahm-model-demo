import { useEffect, useState } from "react";
import type { FormEvent, JSX } from "react";
import type {
  HealthReportBody,
  HealthState,
  ReportOptions,
  SignalValue,
} from "../model/types";
import { useAppDispatch, useAppSelector } from "../store/store";
import { selectReportResult } from "../store/selectors";
import { resetReport, submitHealthReport } from "../store/reportSlice";

const CUSTOM_PRESET = "custom";
const REASON_MIN = 1;
const REASON_MAX = 280;

interface ReportFormProps {
  readonly entityName: string;
  readonly options: ReportOptions;
}

function valueLabel(value: SignalValue): string {
  return value === null ? "No value" : String(value);
}

export function ReportForm({ entityName, options }: ReportFormProps): JSX.Element {
  const dispatch = useAppDispatch();
  const result = useAppSelector(selectReportResult);

  const [healthState, setHealthState] = useState<HealthState>(
    options.healthStates[0] ?? "Healthy",
  );
  const [valueIndex, setValueIndex] = useState(0);
  const [expiresInMinutes, setExpiresInMinutes] = useState(options.expiries[0] ?? 5);
  const [reasonPreset, setReasonPreset] = useState(
    options.reasonPresets[0]?.value ?? CUSTOM_PRESET,
  );
  const [customReason, setCustomReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);

  useEffect(() => {
    dispatch(resetReport());
  }, [dispatch, entityName]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (reasonPreset === CUSTOM_PRESET) {
      const trimmed = customReason.trim();
      if (trimmed.length < REASON_MIN || trimmed.length > REASON_MAX) {
        setReasonError("Enter a custom reason of 1 to 280 characters.");
        return;
      }
    }
    setReasonError(null);
    const value = options.values[valueIndex] ?? null;
    const body: HealthReportBody = {
      signalName: options.signalName,
      healthState,
      value,
      expiresInMinutes,
      reasonPreset,
      ...(reasonPreset === CUSTOM_PRESET ? { customReason: customReason.trim() } : {}),
    };
    void dispatch(submitHealthReport({ name: entityName, body }));
  };

  return (
    <form className="report-form" onSubmit={submit} aria-label="Submit a health report">
      <div className="field">
        <label htmlFor="report-state">Health state</label>
        <select
          id="report-state"
          value={healthState}
          onChange={(event) => setHealthState(event.target.value as HealthState)}
        >
          {options.healthStates.map((state) => (
            <option key={state} value={state}>
              {state}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="report-value">Value</label>
        <select
          id="report-value"
          value={valueIndex}
          onChange={(event) => setValueIndex(Number(event.target.value))}
        >
          {options.values.map((value, index) => (
            <option key={index} value={index}>
              {valueLabel(value)}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="report-expiry">Expires in (minutes)</label>
        <select
          id="report-expiry"
          value={expiresInMinutes}
          onChange={(event) => setExpiresInMinutes(Number(event.target.value))}
        >
          {options.expiries.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="report-reason">Reason</label>
        <select
          id="report-reason"
          value={reasonPreset}
          onChange={(event) => {
            setReasonPreset(event.target.value);
            setReasonError(null);
          }}
        >
          {options.reasonPresets.map((preset) => (
            <option key={preset.value} value={preset.value}>
              {preset.label}
            </option>
          ))}
        </select>
      </div>

      {reasonPreset === CUSTOM_PRESET ? (
        <div className="field">
          <label htmlFor="report-custom-reason">Custom reason</label>
          <textarea
            id="report-custom-reason"
            value={customReason}
            onChange={(event) => setCustomReason(event.target.value)}
            aria-invalid={reasonError !== null}
            aria-describedby="report-custom-reason-error"
          />
          <p id="report-custom-reason-error" className="field-error" role="alert">
            {reasonError ?? ""}
          </p>
        </div>
      ) : null}

      <button type="submit" className="primary">
        Submit report
      </button>

      {result.kind === "success" ? (
        <p className="report-confirmation" data-testid="report-confirmation" role="status">
          Report <strong data-testid="report-id">{result.value.reportId}</strong> accepted,
          expires at <time data-testid="report-expires">{result.value.expiresAt}</time>.
        </p>
      ) : null}
      {result.kind === "failure" ? (
        <p className="report-error" role="alert">
          {result.error.message}
        </p>
      ) : null}
    </form>
  );
}
