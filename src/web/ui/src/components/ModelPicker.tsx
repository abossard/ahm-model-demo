import { memo, useMemo, useState } from "react";
import type { JSX } from "react";
import {
  Combobox,
  Field,
  Option,
  OptionGroup,
  SkeletonItem,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { listModels, modelKey, subscriptionHint } from "../model/modelCatalog";
import type { ModelRef } from "../model/types";
import { actions, useStore } from "../store/store";
import { useInlineField } from "./inlineField";

const useStyles = makeStyles({
  root: { minWidth: 0 },
  input: { minWidth: "200px", width: "min(280px, 65vw)" },
  option: { display: "flex", alignItems: "baseline", gap: tokens.spacingHorizontalS, width: "100%" },
  hint: {
    marginLeft: "auto",
    color: tokens.colorNeutralForeground3,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
  },
  skeleton: { width: "220px", height: "24px" },
  visuallyHidden: {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: 0,
    margin: "-1px",
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    border: 0,
  },
});

function modelLabel(model: ModelRef): string {
  return `${model.name} (${model.resourceGroup})`;
}

const ModelOption = memo(function ModelOption({
  model,
}: {
  readonly model: ModelRef;
}): JSX.Element {
  const styles = useStyles();
  const key = modelKey(model);
  const hint = subscriptionHint(model.subscriptionId);
  return (
    <Option
      value={key}
      text={modelLabel(model)}
      aria-label={`${modelLabel(model)}, subscription ${hint}`}
      data-testid={`model-picker-option-${key}`}
    >
      <span className={styles.option}>
        <span>{modelLabel(model)}</span>{" "}
        <span className={styles.hint}>{hint}</span>
      </span>
    </Option>
  );
});

export function ModelPicker(): JSX.Element | null {
  const styles = useStyles();
  const inlineField = useInlineField();
  const catalog = useStore((state) => state.catalog);
  const selected = useStore((state) => state.selected);
  const unavailable = useStore((state) => state.unavailableSelection);
  const [query, setQuery] = useState("");

  const models = catalog.kind === "success" ? catalog.value.models : null;
  const defaultSubscription = catalog.kind === "success" ? (catalog.value.default?.subscriptionId ?? "") : "";
  const listing = useMemo(
    () => (models ? listModels(models, query, defaultSubscription) : null),
    [models, query, defaultSubscription],
  );
  const byKey = useMemo(
    () => new Map((models ?? []).map((model) => [modelKey(model), model] as const)),
    [models],
  );

  if (catalog.kind === "failure") return null;
  if (catalog.kind !== "success") {
    return <SkeletonItem className={styles.skeleton} aria-hidden="true" />;
  }
  if (!listing || !selected) return null;

  const selectedLabel = modelLabel(selected);
  const selectedKey = modelKey(selected);
  const grouped = listing.groups.length > 1;
  const announcement =
    listing.total === 0
      ? `No models match "${query}". Current selection remains ${selectedLabel}.`
      : `Current selection ${selectedLabel}. ${listing.total} result${listing.total === 1 ? "" : "s"}.`;

  const pick = (model: ModelRef): void => {
    setQuery("");
    actions.chooseModel(model);
  };

  return (
    <div className={styles.root}>
      <Field
        label="Health model"
        orientation="horizontal"
        size="small"
        className={inlineField.root}
        hint={
          <span data-testid="model-picker-selected">
            Selected: {selectedLabel} · {subscriptionHint(selected.subscriptionId)}
          </span>
        }
        validationState={unavailable ? "warning" : "none"}
        validationMessage={
          unavailable ? (
            {
              role: "status",
              children: (
                <span data-testid="model-picker-unavailable-selection">
                  Requested {unavailable.name} ({unavailable.resourceGroup}) is unavailable. Selected:{" "}
                  {selectedLabel}.
                </span>
              ),
            }
          ) : null
        }
      >
        <Combobox
          className={styles.input}
          size="small"
          placeholder="Search model or group"
          aria-label="Search health models"
          data-testid="model-picker-search"
          value={query}
          selectedOptions={[selectedKey]}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setQuery("");
          }}
          onOpenChange={(_, data) => {
            if (!data.open) setQuery("");
          }}
          onOptionSelect={(_, data) => {
            const model = data.optionValue ? byKey.get(data.optionValue) : undefined;
            if (model) pick(model);
          }}
        >
          {listing.total === 0 ? (
            <Option disabled value="__empty" text="" data-testid="model-picker-empty">
              No models match this search.
            </Option>
          ) : null}
          {listing.groups.map((group) =>
            grouped ? (
              <OptionGroup
                key={group.subscriptionId}
                label={`Subscription ${subscriptionHint(group.subscriptionId)}`}
              >
                {group.models.map((model) => (
                  <ModelOption key={modelKey(model)} model={model} />
                ))}
              </OptionGroup>
            ) : (
              group.models.map((model) => <ModelOption key={modelKey(model)} model={model} />)
            ),
          )}
          {listing.shown < listing.total ? (
            <Option disabled value="__capped" text="" data-testid="model-picker-capped">
              {`Showing ${listing.shown} of ${listing.total}. Type to narrow the list.`}
            </Option>
          ) : null}
        </Combobox>
      </Field>
      <input type="hidden" data-testid="model-picker" value={selectedKey} readOnly />
      <span className={styles.visuallyHidden} role="status" data-testid="model-picker-status">
        {announcement}
      </span>
    </div>
  );
}
