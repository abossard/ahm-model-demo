import type { JSX } from "react";
import { ToggleButton } from "@fluentui/react-components";
import { Timeline20Regular } from "@fluentui/react-icons";
import { actions, useStore } from "../store/store";

/** The top-bar switch that opens the timeline under the graph. */
export function TimelineToggle(): JSX.Element {
  const open = useStore((state) => state.timelineOpen);
  return (
    <ToggleButton
      size="small"
      checked={open}
      icon={<Timeline20Regular />}
      aria-controls="timeline-panel"
      onClick={() => actions.toggleTimeline()}
      data-testid="timeline-toggle"
    >
      Timeline
    </ToggleButton>
  );
}
