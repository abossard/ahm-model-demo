import type { LayerId } from "@playground/contracts";
import { Rail } from "../ladder/Rail";
import { ToolRunner } from "../lab/ToolRunner";
import { layerOf } from "../app/career";
import { useStore } from "../app/store";
import { HostLog } from "./HostLog";
import { OfferCard } from "./OfferCard";
import { ViewFrame } from "./ViewFrame";

export function LayerPage({ layer, tableId }: { layer: LayerId; tableId: string | null }) {
  const unlocked = useStore((state) => state.career.unlocked);
  const completed = useStore((state) => state.career.completed);
  const info = layerOf(layer);
  const frontier = unlocked === layer && !(layer === 5 && completed);
  return (
    <div className="layer" data-layer={layer}>
      <Rail current={layer} />
      <div className="stage">
        <header className="stage-head">
          <p className="stage-num display" aria-hidden="true">{String(layer).padStart(2, "0")}</p>
          <div>
            <h1 className="display stage-title">{info.name}</h1>
            <p className="stage-teaches">{info.teaches}</p>
          </div>
          {frontier && (
            <p className="job" data-testid="job">
              <span className="job-label">{layer === 5 ? "Finish the career" : "Opens the next layer"}</span>
              {info.job}
            </p>
          )}
        </header>
        <ViewFrame key={`${layer}:${tableId ?? ""}`} layer={layer} tableId={tableId} />
        <OfferCard />
        <HostLog />
        {layer === 2 && <ToolRunner />}
      </div>
    </div>
  );
}
