import { useState } from "react";
import type { FormEvent, JSX } from "react";
import {
  Button,
  Field,
  MessageBar,
  MessageBarBody,
  Select,
  Textarea,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
  type GriffelStyle,
} from "@fluentui/react-components";
import type {
  HealthReportBody,
  HealthState,
  ReportOptions,
  SignalValue,
} from "../model/types";
import { accessMessage } from "../model/errors";
import { reportTokens, type ReportState, type ReportTokens } from "../model/palette";
import { actions, useStore } from "../store/store";

const CUSTOM_PRESET = "custom";
const REASON_MIN = 1;
const REASON_MAX = 280;

function quickSendStyle(token: ReportTokens): GriffelStyle {
  const colours = { backgroundColor: token.actionFill, color: token.actionInk };
  return {
    ...colours,
    ...shorthands.borderColor(token.actionFill),
    ":hover": { ...colours, filter: "brightness(1.12)" },
    ":hover:active": { ...colours, filter: "brightness(0.92)" },
  };
}

const stateStyles = Object.fromEntries(
  Object.entries(reportTokens).map(([state, token]) => [state, quickSendStyle(token)]),
) as Record<ReportState, GriffelStyle>;

const useStyles = makeStyles({
  form: { display: "flex", flexDirection: "column", rowGap: tokens.spacingVerticalM },
  quickSend: { display: "flex", flexWrap: "wrap", gap: tokens.spacingHorizontalXS },
  submit: { alignSelf: "flex-start" },
  ...stateStyles,
});

interface ReportFormProps {
  readonly entityName: string;
  readonly options: ReportOptions;
}

function valueLabel(value: SignalValue): string {
  return value === null ? "No value" : String(value);
}

export function ReportForm({ entityName, options }: ReportFormProps): JSX.Element {
  const styles = useStyles();
  const result = useStore((state) => state.report);

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

  const send = (state: HealthState): void => {
    if (reasonPreset === CUSTOM_PRESET) {
      const trimmed = customReason.trim();
      if (trimmed.length < REASON_MIN || trimmed.length > REASON_MAX) {
        setReasonError("Enter a custom reason of 1 to 280 characters.");
        return;
      }
    }
    setReasonError(null);
    const body: HealthReportBody = {
      signalName: options.signalName,
      healthState: state,
      value: options.values[valueIndex] ?? null,
      expiresInMinutes,
      reasonPreset,
      ...(reasonPreset === CUSTOM_PRESET ? { customReason: customReason.trim() } : {}),
    };
    void actions.submitHealthReport(entityName, body);
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    send(healthState);
  };

  return (
    <form className={styles.form} onSubmit={submit} aria-label="Submit a health report">
      <div className={styles.quickSend} data-testid="quick-send" role="group" aria-label="Quick send">
        {options.healthStates.map((state) => (
          <Button
            key={state}
            size="small"
            appearance="primary"
            className={mergeClasses(styles[state in reportTokens ? (state as ReportState) : "Unknown"])}
            data-testid={`quick-send-${state}`}
            onClick={() => send(state)}
          >
            {state}
          </Button>
        ))}
      </div>

      <Field label="Health state">
        <Select
          id="report-state"
          value={healthState}
          onChange={(_, data) => setHealthState(data.value as HealthState)}
        >
          {options.healthStates.map((state) => (
            <option key={state} value={state}>
              {state}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Value">
        <Select
          id="report-value"
          value={valueIndex}
          onChange={(_, data) => setValueIndex(Number(data.value))}
        >
          {options.values.map((value, index) => (
            <option key={index} value={index}>
              {valueLabel(value)}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Expires in (minutes)">
        <Select
          id="report-expiry"
          value={expiresInMinutes}
          onChange={(_, data) => setExpiresInMinutes(Number(data.value))}
        >
          {options.expiries.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Reason">
        <Select
          id="report-reason"
          value={reasonPreset}
          onChange={(_, data) => {
            setReasonPreset(data.value);
            setReasonError(null);
          }}
        >
          {options.reasonPresets.map((preset) => (
            <option key={preset.value} value={preset.value}>
              {preset.label}
            </option>
          ))}
        </Select>
      </Field>

      {reasonPreset === CUSTOM_PRESET ? (
        <Field
          label="Custom reason"
          validationState={reasonError ? "error" : "none"}
          validationMessage={
            reasonError ? { id: "report-custom-reason-error", children: reasonError } : null
          }
        >
          <Textarea
            id="report-custom-reason"
            resize="vertical"
            value={customReason}
            onChange={(_, data) => setCustomReason(data.value)}
          />
        </Field>
      ) : null}

      <Button type="submit" appearance="primary" className={styles.submit} data-testid="report-submit">
        Submit report
      </Button>

      {result.kind === "success" ? (
        <MessageBar intent="success" role="status" data-testid="report-confirmation">
          <MessageBarBody>
            Report <strong data-testid="report-id">{result.value.reportId}</strong> accepted,
            expires at <time data-testid="report-expires">{result.value.expiresAt}</time>.
          </MessageBarBody>
        </MessageBar>
      ) : null}
      {result.kind === "failure" ? (
        <MessageBar intent="error" role="alert">
          <MessageBarBody>{accessMessage(result.error, "report")}</MessageBarBody>
        </MessageBar>
      ) : null}
    </form>
  );
}
