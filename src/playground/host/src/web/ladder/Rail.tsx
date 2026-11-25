import { LAYERS, type LayerId } from "@playground/contracts";
import { openLayer } from "../app/actions";
import { rungState } from "../app/career";
import { layerPath } from "../app/route";
import { useStore } from "../app/store";
import { LockIcon } from "../design/icons";

export function Rail({ current }: { current: LayerId }) {
  const career = useStore((state) => state.career);
  return (
    <nav className="rail" data-testid="ladder" aria-label="Layers">
      <ol>
        {LAYERS.map((layer) => {
          const state = rungState(career, layer.id);
          const common = { "data-testid": `rung-${layer.id}`, "data-state": state, "data-layer": layer.id, className: "plate" };
          const inner = (
            <>
              <span className="plate-num">{layer.id}</span>
              <span className="plate-name">{layer.name}</span>
              {state === "locked" && <LockIcon size={14} />}
            </>
          );
          return (
            <li key={layer.id}>
              {state === "open"
                ? <a {...common} href={layerPath(layer.id)} aria-current={layer.id === current ? "page" : undefined} onClick={(event) => { if (!event.metaKey && !event.ctrlKey) { event.preventDefault(); openLayer(layer.id); } }}>{inner}</a>
                : <span {...common} role="img" aria-label={`Layer ${layer.id}, ${layer.name}, locked`}>{inner}</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
