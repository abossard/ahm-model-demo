import { memo } from "react";
import type { JSX, ReactNode } from "react";
import {
  Badge,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
  type GriffelStyle,
} from "@fluentui/react-components";
import { stateTokens } from "../model/palette";
import type { HealthState } from "../model/types";

const stateStyles = Object.fromEntries(
  Object.entries(stateTokens).map(([state, token]) => [
    state,
    { backgroundColor: token.fill, color: token.label, ...shorthands.borderColor(token.border) },
  ]),
) as Record<HealthState, GriffelStyle>;

const useStyles = makeStyles({
  badge: { fontWeight: tokens.fontWeightSemibold },
  ...stateStyles,
});

interface HealthBadgeProps {
  readonly state: string;
  readonly children?: ReactNode;
}

export const HealthBadge = memo(function HealthBadge({
  state,
  children,
}: HealthBadgeProps): JSX.Element {
  const styles = useStyles();
  const known: HealthState = state in stateTokens ? (state as HealthState) : "Unknown";
  return (
    <Badge
      appearance="outline"
      shape="rounded"
      size="large"
      data-testid="health-badge"
      data-state={state}
      className={mergeClasses(styles.badge, styles[known])}
    >
      {children ?? state}
    </Badge>
  );
});
