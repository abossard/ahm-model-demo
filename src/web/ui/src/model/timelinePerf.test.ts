import { describe, expect, it } from "vitest";
import { seriesKey, type Point } from "./timeline";
import { bandsFromPoints, bandsFromTransitions, decimateColumns, holdOf, pixelBands } from "./timelineBands";
import { buildFixture } from "./timelineFixture";
import { allKeys, buildRows, visibleRows } from "./timelineRows";
import { DAY, panBy, zoomAt } from "./timelineScale";

/**
 * The work a frame does that is not drawing: the pixel bands and the decimated columns of every lane that shows. The
 * model is the one the task names: 80 entities, 300 signals, 7 days.
 */
describe("the cost of a frame with 80 entities, 300 signals and 7 days of history", () => {
  const NOW = Date.parse("2026-11-11T12:00:00Z");
  const fixture = buildFixture({ now: NOW, flows: 5, componentsPerFlow: 3, resourcesPerComponent: 4, signalsPerResource: 5, days: 7 });
  const names = fixture.entities.filter((entity) => entity.signals.length > 0).map((entity) => entity.name);
  const loaded = fixture.signals(names, NOW - 7 * DAY, NOW).series;
  const lanes = new Map(loaded.map((item) => [seriesKey(item.entity, item.signal), item.points as readonly Point[]]));
  const prepared = [...lanes.values()].map((points) => ({ points, bands: bandsFromPoints(points, holdOf(points), NOW) }));

  it("is a model of at least 80 entities and 300 signals", () => {
    expect(fixture.entities.length).toBeGreaterThanOrEqual(80);
    expect(fixture.signalCount).toBeGreaterThanOrEqual(300);
    expect(prepared.length).toBeGreaterThanOrEqual(300);
    expect(prepared[0]?.points.length).toBeGreaterThan(1900);
  });

  it.each([
    { lanes: 12, width: 1000, view: 7 * DAY },
    { lanes: 12, width: 1000, view: 6 * 3600_000 },
    { lanes: 30, width: 1600, view: 7 * DAY },
  ])("draws data for $lanes lanes of $width px over $view ms in a few ms", ({ lanes: count, width, view }) => {
    const frames = 300;
    const shown = prepared.slice(0, count);
    let sink = 0;
    const start = performance.now();
    for (let frame = 0; frame < frames; frame += 1) {
      const t1 = NOW - frame * 60_000;
      for (const lane of shown) {
        sink += pixelBands(lane.bands, t1 - view, t1, width).length;
        sink += decimateColumns(lane.points, t1 - view, t1, width).x.length;
      }
    }
    const perFrame = (performance.now() - start) / frames;
    console.log(`timeline data work: ${count} lanes, ${width}px, ${view / 3600_000}h window: ${perFrame.toFixed(2)} ms per frame (${sink} items)`);

    expect(perFrame).toBeLessThan(8);
  });

  it("builds the rows of the whole model and finds the visible ones in well under a millisecond", () => {
    const start = performance.now();
    const model = buildRows({ entities: fixture.entities, order: "worst", open: new Set(allKeys(fixture.entities)), rank: (name) => fixture.entities.find((entity) => entity.name === name)?.state ?? 0 });
    const built = performance.now() - start;
    const found = performance.now();
    for (let i = 0; i < 1000; i += 1) visibleRows(model, i * 37, 600);
    const lookup = (performance.now() - found) / 1000;
    console.log(`timeline rows: ${model.rows.length} rows built in ${built.toFixed(2)} ms, visible range in ${lookup.toFixed(4)} ms`);

    expect(model.rows.length).toBeGreaterThan(380);
    expect(lookup).toBeLessThan(0.2);
  });

  it("transitions of 80 entities become bands quickly", () => {
    const overview = fixture.overview(NOW - 7 * DAY, NOW);
    const start = performance.now();
    let bands = 0;
    for (const item of overview.states) bands += bandsFromTransitions(item.transitions, { from: NOW - 7 * DAY, to: NOW }, 1).length;
    console.log(`timeline bands: ${bands} bands for ${overview.states.length} entities in ${(performance.now() - start).toFixed(2)} ms`);

    expect(performance.now() - start).toBeLessThan(50);
  });

  it("zooming and panning are arithmetic", () => {
    let view = { t0: NOW - 7 * DAY, t1: NOW };
    const bounds = { lo: NOW - 14 * DAY, hi: NOW };
    const start = performance.now();
    for (let i = 0; i < 100_000; i += 1) {
      view = zoomAt(view, view.t0 + (view.t1 - view.t0) / 3, i % 2 === 0 ? 0.9 : 1.1, bounds);
      view = panBy(view, 1000, bounds);
    }
    expect(performance.now() - start).toBeLessThan(200);
  });
});
