import { LAYERS, type LayerId } from "@playground/contracts";
import { openLayer } from "../app/actions";
import { jobToOpen, layerOf, rungState } from "../app/career";
import { layerPath } from "../app/route";
import { useStore } from "../app/store";
import { ArrowIcon, LockIcon, Motif } from "../design/icons";

const pad = (n: number) => String(n).padStart(2, "0");

function Panel({ layer, highlighted }: { layer: LayerId; highlighted: boolean }) {
  const career = useStore((state) => state.career);
  const info = layerOf(layer);
  const state = rungState(career, layer);
  const body = (
    <>
      <span className="panel-num">{pad(layer)}</span>
      <span className="panel-name">{info.name}</span>
      {state === "open" ? (
        <>
          <span className="panel-text">{info.teaches}</span>
          <span className="panel-go">{career.unlocked === layer && layer < 5 ? "Do the job to go further" : "Open"} <ArrowIcon /></span>
        </>
      ) : (
        <span className="panel-lock">
          <LockIcon size={18} />
          <span><span className="panel-lock-label">Locked.</span> {jobToOpen(layer)}</span>
        </span>
      )}
      <Motif layer={layer} />
    </>
  );
  const common = { "data-testid": `rung-${layer}`, "data-state": state, "data-layer": layer, "data-highlight": highlighted || undefined, className: `panel panel-${layer}` };
  return state === "open"
    ? <a {...common} href={layerPath(layer)} onClick={(event) => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey) { event.preventDefault(); openLayer(layer); } }}>{body}</a>
    : <div {...common} role="group" aria-label={`Layer ${layer}, ${info.name}, locked. ${jobToOpen(layer)}`}>{body}</div>;
}

export function Home({ highlight }: { highlight: LayerId | null }) {
  return (
    <div className="home">
      <section className="intro">
        <h1 className="display intro-title">Learn MCP Apps by using them.</h1>
        <p className="intro-text">
          Five layers, each a real MCP App: a tool, a <code>ui://</code> View, a sandboxed frame. Every message that crosses the wire is in the drawer on the right. Using a layer opens the next.
        </p>
      </section>
      {highlight && (
        <p className="highlight-note" role="status">
          Layer {highlight}, {layerOf(highlight).name}, is still locked. {jobToOpen(highlight)}
        </p>
      )}
      <nav className="collage" data-testid="ladder" aria-label="The five layers">
        {LAYERS.map((layer) => <Panel key={layer.id} layer={layer.id} highlighted={highlight === layer.id} />)}
      </nav>
    </div>
  );
}
