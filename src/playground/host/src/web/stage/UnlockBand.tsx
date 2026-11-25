import { useEffect } from "react";
import { clearBand } from "../app/actions";
import { useStore } from "../app/store";

// The one big moment. CSS moves it; the timer is a net for a tab that never ran the animation.
// Any key or click skips it.
export function UnlockBand() {
  const band = useStore((state) => state.band);
  useEffect(() => {
    if (!band) return;
    const timer = setTimeout(clearBand, 4200);
    window.addEventListener("keydown", clearBand);
    window.addEventListener("pointerdown", clearBand);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", clearBand);
      window.removeEventListener("pointerdown", clearBand);
    };
  }, [band]);
  if (!band) return null;
  return (
    <>
      <div className="band" data-testid="unlock-band" data-layer={band.layer} role="status" onAnimationEnd={clearBand}>
        <span className="band-head display">{band.headline}</span>
        <span className="band-name display">{band.name}</span>
      </div>
      <div className="stamp display" data-testid="mission-passed" data-layer={band.layer} aria-hidden="true">Mission passed</div>
    </>
  );
}
