import { useEffect } from "react";
import { boot, cheat, connect, goHome, toggleDrawer } from "./actions";
import { layerOf, progressLine } from "./career";
import { CHEAT_START, isTypingTarget, nextCheat, type CheatState } from "./cheat";
import { resolveRoute } from "./route";
import { useStore } from "./store";
import { WireChip } from "../drawer/WireChip";
import { WireDrawer } from "../drawer/WireDrawer";
import { Home } from "../ladder/Home";
import { LayerPage } from "../stage/LayerPage";
import { OfferCard } from "../stage/OfferCard";
import { UnlockBand } from "../stage/UnlockBand";

function useGlobalKeys() {
  useEffect(() => {
    let cheatState: CheatState = CHEAT_START;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && isTypingTarget(target.tagName ?? "", target.isContentEditable === true)) return;
      if (event.key === "`") {
        event.preventDefault();
        toggleDrawer();
        return;
      }
      cheatState = nextCheat(cheatState, event.key);
      if (cheatState.hit) void cheat();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function App() {
  useGlobalKeys();
  useEffect(() => {
    void boot();
  }, []);
  const route = useStore((state) => state.route);
  const unlocked = useStore((state) => state.career.unlocked);
  const career = useStore((state) => state.career);
  const connection = useStore((state) => state.connection);
  const error = useStore((state) => state.connectionError);
  const fixture = useStore((state) => state.fixture);
  const open = useStore((state) => state.drawer.open);
  const resolved = resolveRoute(route, unlocked);

  useEffect(() => {
    document.title = resolved.page === "layer" ? `${layerOf(resolved.layer).name} · MCP App Playground` : "MCP App Playground";
  }, [resolved]);

  return (
    <div className="shell" data-drawer={open}>
      <a className="skip" href="#main">Skip to the page</a>
      <div className="page">
        <header className="top">
          <button type="button" className="brand display" onClick={goHome}>
            MCP App Playground
          </button>
          <p className="top-progress">{fixture && <span className="top-fixture">Fixture data</span>}{progressLine(career)}</p>
        </header>
        {connection === "failed" && (
          <div className="banner" role="alert">
            <p>Could not reach the MCP server: {error}</p>
            <button type="button" className="btn" onClick={() => void connect()}>Try again</button>
          </div>
        )}
        <main id="main" tabIndex={-1}>
          {resolved.page === "home" ? (
            <>
              <OfferCard />
              <Home highlight={resolved.highlight} />
            </>
          ) : (
            <LayerPage layer={resolved.layer} tableId={resolved.tableId} />
          )}
        </main>
      </div>
      <WireDrawer />
      <WireChip />
      <UnlockBand />
    </div>
  );
}
