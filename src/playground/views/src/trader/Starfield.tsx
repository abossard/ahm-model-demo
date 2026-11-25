import { useEffect, useRef } from "react";

// Three depth layers of square pixel stars. Far stars are small, dim and slow; near ones are larger, brighter and quicker.
const LAYERS = [
  { count: 36, size: 1, speed: 3, color: "169, 162, 148", alpha: 0.35 },
  { count: 20, size: 2, speed: 8, color: "88, 199, 243", alpha: 0.4 },
  { count: 9, size: 3, speed: 16, color: "242, 237, 226", alpha: 0.5 },
] as const;
const DRIFT = { x: -1, y: 0.25 };
const WARP_MS = 900;
const WARP_BOOST = 24;

// A small seeded generator keeps the field the same on every load.
function seeded(seed: number): () => number {
  let a = seed;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// `travel` is the way the ship went, as a unit vector on the map. A new one streaks the field the other way, once.
export function Starfield({ travel }: { travel: { dx: number; dy: number; id: number } | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const warp = useRef<{ at: number; dx: number; dy: number } | null>(null);

  useEffect(() => { if (travel) warp.current = { at: performance.now(), dx: travel.dx, dy: travel.dy }; }, [travel]);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const rand = seeded(7);
    const stars = LAYERS.map((layer) => Array.from({ length: layer.count }, () => ({ x: rand(), y: rand() })));
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let last = performance.now();
    const offset = LAYERS.map(() => ({ x: 0, y: 0 }));

    const draw = (now: number) => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(el.clientWidth * dpr);
      const h = Math.round(el.clientHeight * dpr);
      if (el.width !== w || el.height !== h) { el.width = w; el.height = h; }
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, w, h);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const t = warp.current ? (now - warp.current.at) / WARP_MS : 1;
      const boost = t < 1 ? 1 + WARP_BOOST * (1 - t) ** 2 : 1;
      const way = t < 1 && warp.current ? { x: -warp.current.dx, y: -warp.current.dy } : DRIFT;
      LAYERS.forEach((layer, i) => {
        const o = offset[i]!;
        if (!still) { o.x += way.x * layer.speed * boost * dt * dpr; o.y += way.y * layer.speed * boost * dt * dpr; }
        const size = layer.size * Math.max(1, Math.round(dpr));
        const streak = t < 1 ? Math.round(size * (boost - 1) * 0.6) : 0;
        const along = Math.abs(way.x) >= Math.abs(way.y) ? "x" : "y";
        ctx.fillStyle = `rgba(${layer.color}, ${layer.alpha})`;
        for (const star of stars[i]!) {
          const x = Math.round((((star.x * w + o.x) % w) + w) % w);
          const y = Math.round((((star.y * h + o.y) % h) + h) % h);
          // The streak trails behind the star, against the way it moves.
          const sx = along === "x" && way.x > 0 ? x - streak : x;
          const sy = along === "y" && way.y > 0 ? y - streak : y;
          ctx.fillRect(sx, sy, along === "x" ? size + streak : size, along === "y" ? size + streak : size);
        }
      });
    };

    const frame = (now: number) => { draw(now); raf = requestAnimationFrame(frame); };
    const run = () => { cancelAnimationFrame(raf); last = performance.now(); if (!still && !document.hidden) raf = requestAnimationFrame(frame); else draw(last); };
    const observer = new ResizeObserver(() => draw(performance.now()));
    observer.observe(el);
    document.addEventListener("visibilitychange", run);
    run();
    return () => { cancelAnimationFrame(raf); observer.disconnect(); document.removeEventListener("visibilitychange", run); };
  }, []);

  return <canvas ref={canvas} className="starfield" aria-hidden="true" />;
}
