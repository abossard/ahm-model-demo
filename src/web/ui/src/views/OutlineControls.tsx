import type { JSX } from "react";
import { Button } from "@fluentui/react-components";
import { expandAllOverrides } from "../model/outline";
import { actions } from "../store/store";
import type { ViewControlsProps } from "./types";
import { useOutlineState } from "./outlineState";

/** Open every row, or go back to the default: only what needs attention open. */
export function OutlineControls({ entities, relationships }: ViewControlsProps): JSX.Element {
  const replace = useOutlineState((state) => state.replace);
  return (
    <>
      <Button
        size="small"
        data-testid="outline-expand-all"
        onClick={() => {
          replace(expandAllOverrides(entities, relationships));
          actions.announce("Every row expanded.");
        }}
      >
        Expand all
      </Button>
      <Button
        size="small"
        data-testid="outline-collapse-healthy"
        onClick={() => {
          replace(new Map());
          actions.announce("Healthy subtrees collapsed.");
        }}
      >
        Collapse healthy
      </Button>
    </>
  );
}
