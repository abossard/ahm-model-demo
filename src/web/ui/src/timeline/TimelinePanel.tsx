import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { Button, MenuButton, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, MessageBar, MessageBarActions, MessageBarBody, Spinner, ToggleButton, mergeClasses } from "@fluentui/react-components";
import { Dismiss20Regular, FullScreenMaximize20Regular, FullScreenMinimize20Regular } from "@fluentui/react-icons";
import { formatDuration } from "../model/duration";
import { seriesKey, type EntityInfo, type StateCode } from "../model/timeline";
import { bandAt, holdOf, parseDuration, type Band } from "../model/timelineBands";
import { signalFacts } from "../model/timelineTree";
import { historyAt } from "../model/timeTravel";
import { detectIncidents, entityBands, incidentText, modelAt, type Incident } from "../model/timelineIncidents";
import { allKeys, buildRows, heldRows, moveFocus, revealKeys, rootEntity, scrollToShow, type Row } from "../model/timelineRows";
import { PRESETS, formatClock, formatDay, formatInstant, padView, presetOf, presetView } from "../model/timelineScale";
import { actions, useStore } from "../store/store";
import { TIMELINE_MAX_HEIGHT, TIMELINE_MIN_HEIGHT, timelineBounds } from "../store/timelineSlice";
import { readColors, type TimelineColors } from "./colors";
import { AXIS_HEIGHT } from "./draw";
import { Plot, type PlotModel } from "./plot";
import { renderTip } from "./tooltip";
import { TimelineEntity } from "./TimelineEntity";
import { TimelineLabels, type TreeFacts } from "./TimelineLabels";
import { TimelineLegend } from "./TimelineLegend";
import { useInertElsewhere } from "./useInertElsewhere";
import { useTimelineLoading } from "./useTimelineLoading";
import { useStyles } from "./styles";
import "./timeline.css";

const OFFSET_MIN = new Date().getTimezoneOffset();

/** The signal timeline: a tree of entities with their signals and dependencies beside a shared time axis. */
export function TimelinePanel(): JSX.Element {
  const styles = useStyles();
  const height = useStore((state) => state.timelineHeight);
  const storedView = useStore((state) => state.timelineView);
  const follow = useStore((state) => state.timelineFollow);
  const skew = useStore((state) => state.liveSkew);
  const liveStatus = useStore((state) => state.liveStatus);
  const stale = useStore((state) => state.timelineStale);
  const data = useStore((state) => state.timelineData);
  const seriesStore = useStore((state) => state.timelineSeries);
  const status = useStore((state) => state.timelineStatus);
  const error = useStore((state) => state.timelineError);
  const loading = useStore((state) => state.timelineLoading);
  const expanded = useStore((state) => state.timelineExpanded);
  const order = useStore((state) => state.timelineOrder);
  const fullscreen = useStore((state) => state.timelineFullscreen);
  const focus = useStore((state) => state.timelineFocus);
  const theme = useStore((state) => state.theme);
  const selectedName = useStore((state) => state.selectedName);
  const highlightedName = useStore((state) => state.highlightedName);

  const rootRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const plotRef = useRef<Plot | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const proxyRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(0);
  const [range, setRange] = useState<readonly [number, number]>([0, 0]);
  const rangeRef = useRef(range);
  // The selected moment moves once per frame while it is dragged. The plot draws it from the store by itself; what this
  // panel derives from it (the tree as of then) follows as a transition, so a drag never waits for React.
  const [pinned, setPinned] = useState(() => useStore.getState().timelinePinned);
  useEffect(() => {
    setPinned(useStore.getState().timelinePinned);
    return useStore.subscribe((state, before) => {
      if (state.timelinePinned !== before.timelinePinned) startTransition(() => setPinned(state.timelinePinned));
    });
  }, []);
  const [colors, setColors] = useState<TimelineColors | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const resetRef = useRef<() => void>(() => undefined);
  const firstView = useRef(true);
  /** The row to bring into view once it is there. */
  const wantScroll = useRef<string | null>(null);
  const handledFocus = useRef(0);

  useInertElsewhere(rootRef, fullscreen);

  // Escape leaves full screen from wherever the focus is, unless it is closing something that opened over the timeline.
  useEffect(() => {
    if (!fullscreen) return;
    const leave = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector('[role="dialog"], [role="menu"]')) return;
      actions.setTimelineFullscreen(false);
    };
    window.addEventListener("keydown", leave);
    return () => window.removeEventListener("keydown", leave);
  }, [fullscreen]);

  // While following, the window is as long as the stored one and ends at the newest instant the data reaches.
  const view = useMemo(() => (storedView !== null && follow ? { t0: data.now - (storedView.t1 - storedView.t0), t1: data.now } : storedView), [storedView, follow, data.now]);
  const entities = useMemo(() => new Map(data.entities.map((entity) => [entity.name, entity])), [data.entities]);
  const bounds = useMemo(() => timelineBounds(data, Date.now()), [data]);
  const bandCache = useMemo(() => new Map<string, readonly Band[]>(), [data]);
  const bandsOf = useCallback(
    (entity: EntityInfo): readonly Band[] => {
      const held = bandCache.get(entity.name);
      if (held) return held;
      const made = entityBands(data, entity);
      bandCache.set(entity.name, made);
      return made;
    },
    [data, bandCache],
  );
  const graphModel = useStore((state) => state.model);
  const impacts = useMemo(() => new Map(graphModel.kind === "success" ? graphModel.value.entities.map((entity) => [entity.name, entity.impact]) : []), [graphModel]);
  const asOf = pinned ?? data.now;
  const facts = useMemo<TreeFacts>(
    () => ({
      entity: (name) => {
        const entity = entities.get(name);
        if (!entity) return { state: 0, impact: "Standard" };
        const state: StateCode = pinned === null ? entity.state : (bandAt(bandsOf(entity), pinned) ?? 0);
        return { state, impact: impacts.get(name) ?? "Standard" };
      },
      signal: (entity, signal) => {
        const info = entities.get(entity)?.signals.find((item) => item.name === signal);
        // At a selected moment the evaluation itself is read, from the finest points held, not the thinned ones the plot draws.
        const held = (pinned === null ? undefined : historyAt(seriesStore.series[seriesKey(entity, signal)], pinned)) ?? data.series[seriesKey(entity, signal)];
        return signalFacts(info, held, asOf, held ? holdOf(held.points, parseDuration(info?.refreshInterval ?? null)) : 300_000);
      },
    }),
    [entities, bandsOf, pinned, impacts, data, seriesStore, asOf],
  );

  // Only the worst-first order looks at states: in the order of the model the rows stay as they are while data arrives.
  const rank = useMemo(
    () =>
      order !== "worst"
        ? null
        : (name: string): StateCode => {
            const entity = entities.get(name);
            if (!entity) return 0;
            return pinned === null ? entity.state : (bandAt(bandsOf(entity), pinned) ?? 0);
          },
    [order, entities, bandsOf, pinned],
  );
  const rowModel = useMemo(() => buildRows({ entities: data.entities, order, open: new Set(expanded), rank: rank ?? (() => 1) }), [data.entities, order, expanded, rank]);
  const rowsRef = useRef(rowModel);
  rowsRef.current = rowModel;

  const incidents = useMemo<readonly Incident[]>(() => {
    const root = rootEntity(data.entities);
    return root ? detectIncidents(entityBands(data, root), data.now, 5 * 60_000) : [];
  }, [data]);

  const selectedEntity = selectedName ?? highlightedName;
  useTimelineLoading(rowModel, range, bounds, view);

  /* The latest values, for the plot's hooks, which are made once. */
  const latest = useRef({ data, bounds, incidents, entities });
  latest.current = { data, bounds, incidents, entities };

  const summaryAt = useCallback(
    (t: number): string => {
      const rows = modelAt(data, t, bandsOf).filter((row) => row.code === 2 || row.code === 3);
      return `${formatInstant(t, OFFSET_MIN)}: ${rows.length === 0 ? "nothing degraded or unhealthy" : rows.map((row) => `${row.displayName} ${row.state}`).join(", ")}`;
    },
    [data, bandsOf],
  );
  const summaryRef = useRef(summaryAt);
  summaryRef.current = summaryAt;

  /*
   * The plot owns where the rows are scrolled to and says so in the frame it draws them: the tree and the scrollbar
   * follow there. The rows of the tree are cut anew only once the held ones run out, so a scroll does not render per row.
   */
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const cutRange = useCallback((top: number, fresh: boolean): void => {
    const held = rangeRef.current;
    const next = heldRows(rowsRef.current, top, viewportRef.current, fresh ? null : held);
    if (next[0] === held[0] && next[1] === held[1]) return;
    rangeRef.current = next;
    setRange(next);
  }, []);

  /* Plot lifetime */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let announceTimer = 0;
    const plot = new Plot(canvas, {
      view: (next) => actions.setTimelineView(next),
      pin: (t) => actions.pinTimeline(t),
      scroll: (top) => {
        if (bodyRef.current) bodyRef.current.scrollTop = top;
        if (proxyRef.current) proxyRef.current.scrollTop = top;
        cutRange(top, false);
      },
      focus: (row) => setFocusKey(row.key),
      incident: (incident) => {
        const { bounds: limits, data: held } = latest.current;
        const next = padView(incident.from, incident.to ?? held.now, limits);
        actions.setTimelineView(next);
        actions.pinTimeline(incident.from);
      },
      reset: () => resetRef.current(),
      tip: (tip, x, y, offset) => {
        const host = tipRef.current;
        const wrap = canvas.parentElement;
        if (!host || !wrap) return;
        if (tip === null) {
          host.hidden = true;
          return;
        }
        host.hidden = false;
        renderTip(host, tipClasses.current, tip, offset);
        const room = wrap.clientWidth;
        const left = x + 14 + host.offsetWidth > room ? Math.max(0, x - 14 - host.offsetWidth) : x + 14;
        const top = Math.min(Math.max(AXIS_HEIGHT, y + 8), Math.max(AXIS_HEIGHT, wrap.clientHeight - host.offsetHeight - 4));
        host.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
      },
      announce: () => {
        window.clearTimeout(announceTimer);
        announceTimer = window.setTimeout(() => {
          const t = plot.getMoment();
          if (t !== null) setLive(summaryRef.current(t));
        }, 300);
      },
    });
    plotRef.current = plot;
    plot.setMoment(useStore.getState().timelinePinned);
    const unsubscribe = useStore.subscribe((state, before) => {
      if (state.timelinePinned !== before.timelinePinned) plot.setMoment(state.timelinePinned);
    });
    // One listener for the whole stage, the tree as well as the plot: the plot reads the gesture and nothing is left for the page.
    const stage = stageRef.current;
    const onWheel = (event: WheelEvent): void => plot.handleWheel(event);
    stage?.addEventListener("wheel", onWheel, { passive: false });
    const observer = new ResizeObserver(() => {
      plot.resize();
      if (stage) setViewport(Math.max(0, stage.clientHeight - AXIS_HEIGHT));
    });
    observer.observe(canvas);
    plot.resize();
    return () => {
      observer.disconnect();
      unsubscribe();
      stage?.removeEventListener("wheel", onWheel);
      window.clearTimeout(announceTimer);
      plot.destroy();
      plotRef.current = null;
    };
  }, [cutRange]);

  const tipClasses = useRef<Record<string, string>>({});
  tipClasses.current = {
    tipHead: styles.tipHead,
    tipLine: styles.tipLine,
    tipGlyph: styles.tipGlyph,
    tipName: styles.tipName,
    tipContext: styles.tipContext,
    tipValue: styles.tipValue,
    tipMarker: styles.tipMarker,
    tipMore: styles.tipMore,
  };

  /* Colours follow the theme: read them once the new theme's variables are in place. */
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const host = canvasRef.current;
      if (host) setColors(readColors(host));
    });
    return () => cancelAnimationFrame(frame);
  }, [theme]);

  const model = useMemo<PlotModel | null>(
    () =>
      colors === null
        ? null
        : {
            data,
            rows: rowModel,
            colors,
            selectedName: selectedEntity,
            loading: new Set(loading),
            incidents,
            bounds,
            offsetMin: OFFSET_MIN,
            follow: follow && liveStatus !== "off" && liveStatus !== "paused" ? { skew } : null,
          },
    [colors, data, rowModel, selectedEntity, loading, incidents, bounds, follow, liveStatus, skew],
  );
  useEffect(() => {
    if (model) plotRef.current?.setModel(model);
  }, [model]);
  useEffect(() => {
    cutRange(plotRef.current?.getScroll() ?? 0, true);
  }, [rowModel, viewport, cutRange]);
  useEffect(() => {
    if (view === null || model === null) return;
    plotRef.current?.setView(view, !firstView.current);
    firstView.current = false;
  }, [view, model === null]); // eslint-disable-line react-hooks/exhaustive-deps

  /* An entity picked anywhere: the way to it opens, its signals open, its row is focused and scrolled to. */
  useEffect(() => {
    if (focus === null || focus.seq === handledFocus.current || data.entities.length === 0) return;
    handledFocus.current = focus.seq;
    const keys = revealKeys(data.entities, focus.name, { open: new Set(expanded), prefer: focus.key });
    const own = keys.at(-1);
    if (own === undefined) return;
    actions.expandTimelineEntities(keys);
    wantScroll.current = own;
    setFocusKey(own);
  }, [focus, data.entities, expanded]);
  useEffect(() => {
    const key = wantScroll.current;
    const index = key === null ? undefined : rowModel.indexByKey.get(key);
    const row = index === undefined ? undefined : rowModel.rows[index];
    const plot = plotRef.current;
    // The plot scrolls as far as the rows it has go: it has them once it has a model.
    if (!row || !plot || viewport === 0 || model === null) return;
    wantScroll.current = null;
    const top = scrollToShow(row, plot.getScroll(), viewport);
    if (top !== null) plot.scrollTo(top);
  }, [focusKey, rowModel, viewport, model === null]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Keys: time keys belong to the plot, row keys to the tree. */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // Escape leaves full screen before it does anything else.
    if (event.key === "Escape" && fullscreen) return;
    const plot = plotRef.current;
    const current = focusKey === null ? -1 : (rowModel.indexByKey.get(focusKey) ?? -1);
    if (plot?.handleKey(event.nativeEvent, rowModel.rows[current] ?? null)) {
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "PageDown" || event.key === "PageUp") {
      const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : event.key === "PageDown" ? 8 : -8;
      const next = rowModel.rows[moveFocus(rowModel, Math.max(0, current), current < 0 ? 0 : step)];
      if (next) {
        wantScroll.current = next.key;
        setFocusKey(next.key);
      }
      event.preventDefault();
    } else if (event.key === "Enter") {
      const row = rowModel.rows[current];
      if (row) activate(row);
      event.preventDefault();
    }
  };
  /** Enter picks a row's entity, which opens it; on an open row it closes it again. */
  const activate = (row: Row): void => {
    if (row.kind === "entity" && row.expanded) actions.toggleTimelineEntity(row.key);
    else onSelectRow(row);
  };

  const onSelectRow = useCallback((row: Row) => {
    actions.showInTimeline(row.entity, row.kind === "entity" ? row.key : row.parent);
    void actions.selectEntity(row.entity);
  }, []);

  /* The height grip. */
  const dragRef = useRef<{ y: number; h: number } | null>(null);
  const onGripDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { y: event.clientY, h: height };
  };
  const onGripMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current) actions.setTimelineHeight(dragRef.current.h + (dragRef.current.y - event.clientY));
  };
  const onGripKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "ArrowUp") actions.setTimelineHeight(height + 24);
    else if (event.key === "ArrowDown") actions.setTimelineHeight(height - 24);
    else return;
    event.preventDefault();
  };

  const active = view === null ? null : presetOf(view, bounds);
  const reset = (): void => {
    actions.setTimelineView(presetView("24h", latest.current.bounds));
    actions.followTimeline(true);
  };
  resetRef.current = reset;
  const busy = status === "loading" || loading.length > 0;
  const partial = Object.values(data.series).some((held) => held.error !== null);
  const modelRows = useMemo(() => (pinned === null ? [] : modelAt(data, pinned, bandsOf)), [data, pinned, bandsOf]);
  const troubledNames = modelRows.filter((row) => row.code === 2 || row.code === 3).sort((a, b) => b.code - a.code);
  const zoomToIncident = (incident: Incident): void => {
    actions.setTimelineView(padView(incident.from, incident.to ?? data.now, bounds));
    actions.pinTimeline(incident.from);
  };

  return (
    <section
      ref={rootRef}
      id="timeline-panel"
      className={mergeClasses(styles.panel, fullscreen && styles.full)}
      style={fullscreen ? undefined : { height }}
      aria-label="Signal timeline"
      data-testid="timeline-panel"
      data-fullscreen={fullscreen}
    >
      {fullscreen ? null : (
        <div
          className={styles.grip}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the timeline"
          aria-valuemin={TIMELINE_MIN_HEIGHT}
          aria-valuemax={TIMELINE_MAX_HEIGHT}
          aria-valuenow={height}
          tabIndex={0}
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={() => (dragRef.current = null)}
          onKeyDown={onGripKey}
          data-testid="tl-grip"
        />
      )}
      <div className={styles.toolbar}>
        <span className={styles.title}>Timeline</span>
        <div className={styles.presets} role="group" aria-label="Time range">
          {PRESETS.map((preset) => (
            <ToggleButton
              key={preset.id}
              size="small"
              checked={active === preset.id}
              onClick={() => {
                actions.setTimelineView(presetView(preset.id, bounds));
                actions.followTimeline(true);
              }}
              data-testid={`tl-preset-${preset.id}`}
            >
              {preset.label}
            </ToggleButton>
          ))}
        </div>
        {view ? (
          <span className={styles.range} data-testid="tl-range">
            {formatDay(view.t0, OFFSET_MIN)} {formatClock(view.t0, OFFSET_MIN)} to {formatDay(view.t1, OFFSET_MIN)} {formatClock(view.t1, OFFSET_MIN)} · {formatDuration(view.t1 - view.t0)}
          </span>
        ) : null}
        <ToggleButton
          size="small"
          checked={follow}
          onClick={() => actions.followTimeline(!follow)}
          data-testid="tl-live-toggle"
          title="Keep now at the right edge while new points arrive"
        >
          Live
        </ToggleButton>
        <ToggleButton size="small" checked={order === "worst"} onClick={() => actions.setTimelineOrder(order === "worst" ? "structure" : "worst")} data-testid="tl-order">
          Worst first
        </ToggleButton>
        <Button size="small" onClick={() => actions.expandTimelineEntities(allKeys(data.entities))} data-testid="tl-expand-all">
          Expand all
        </Button>
        <Button size="small" onClick={() => actions.collapseTimelineEntities()} data-testid="tl-collapse-all">
          Collapse all
        </Button>
        {incidents.length > 0 ? (
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <MenuButton size="small" data-testid="tl-incidents">
                Incidents ({incidents.length})
              </MenuButton>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                {[...incidents].reverse().map((incident) => (
                  <MenuItem key={incident.id} onClick={() => zoomToIncident(incident)} data-testid="tl-incident">
                    {formatInstant(incident.from, OFFSET_MIN)}: {incidentText(incident, data.now)}
                  </MenuItem>
                ))}
              </MenuList>
            </MenuPopover>
          </Menu>
        ) : null}
        {pinned !== null ? (
          <div className={styles.pinned} role="group" aria-label="Pinned moment" data-testid="tl-model-at">
            <span>The model at {formatInstant(pinned, OFFSET_MIN)}</span>
            <Button
              size="small"
              appearance="primary"
              disabled={troubledNames.length === 0}
              onClick={() => {
                const first = troubledNames[0];
                if (first) actions.focusEntities({ highlight: first.entity, names: troubledNames.map((row) => row.entity) });
              }}
              data-testid="tl-show-on-graph"
            >
              Show on graph
            </Button>
            <Button size="small" onClick={() => actions.pinTimeline(null)} data-testid="tl-unpin">
              Unpin
            </Button>
          </div>
        ) : null}
        {stale ? <span className={styles.range} data-testid="tl-stale">Showing what was kept, updating…</span> : null}
        {busy ? <Spinner size="tiny" label="Loading history…" labelPosition="after" data-testid="tl-busy" /> : null}
        {partial ? (
          <Button size="small" appearance="subtle" onClick={() => actions.retryTimelineSignals(data.entities.map((entity) => entity.name))} data-testid="tl-retry">
            Some signals failed: retry
          </Button>
        ) : null}
        <span className={styles.spacer} />
        <Button
          size="small"
          appearance="subtle"
          icon={fullscreen ? <FullScreenMinimize20Regular /> : <FullScreenMaximize20Regular />}
          aria-label={fullscreen ? "Leave full screen" : "Full screen"}
          title={fullscreen ? "Leave full screen (Escape)" : "Full screen"}
          onClick={() => actions.setTimelineFullscreen(!fullscreen)}
          data-testid="tl-fullscreen"
        />
        <Button size="small" appearance="subtle" icon={<Dismiss20Regular />} aria-label="Close the timeline" onClick={() => actions.closeTimeline()} data-testid="tl-close" />
      </div>
      {status === "failed" && error ? (
        <MessageBar intent="error" data-testid="tl-error">
          <MessageBarBody>{error.message}</MessageBarBody>
          <MessageBarActions>
            <Button size="small" onClick={() => void actions.loadTimelineOverview()}>
              Retry
            </Button>
          </MessageBarActions>
        </MessageBar>
      ) : null}
      <TimelineLegend standby={data.entities.some((entity) => entity.state === 4)} />
      {selectedName !== null && graphModel.kind === "success" ? (
        <TimelineEntity options={graphModel.value.reportOptions} changes={data.states[selectedName]?.transitions ?? []} offsetMin={OFFSET_MIN} />
      ) : null}
      <div className={styles.body}>
        <div
          ref={stageRef}
          className={styles.stage}
          tabIndex={0}
          role="tree"
          aria-label="Entities and their signals over time. Left and right move the selected moment, with Shift to the state change before or after it in the focused row; Escape returns to now. Up and down move between rows, Enter picks a row and opens it or closes it, plus and minus zoom, space selects the moment under the pointer. Scrolling moves through the rows, a pinch or Control and scrolling zooms, scrolling sideways or with Shift moves in time."
          aria-activedescendant={focusKey === null || rowModel.indexByKey.get(focusKey) === undefined ? undefined : `tl-row-${rowModel.indexByKey.get(focusKey)}`}
          onKeyDown={onKeyDown}
          data-testid="tl-stage"
        >
          <div className={styles.labels}>
            <div className={styles.labelsHead}>
              <span>Entity / signal</span>
              <span className={mergeClasses(styles.asOf, pinned !== null && styles.asOfPinned)} data-testid="tl-asof">
                {pinned === null ? "Now" : `As of ${formatInstant(pinned, OFFSET_MIN)}`}
              </span>
              <span className={styles.incidentsLabel}>Incidents</span>
            </div>
            <div
              className={styles.labelsBody}
              // A row the browser brings into view scrolls this box itself: the plot follows, and brings the box back when it went too far.
              onScroll={(event) => plotRef.current?.scrollTo(event.currentTarget.scrollTop)}
              ref={bodyRef}
              data-testid="tl-labels-body"
            >
              <div className={styles.labelsInner} style={{ height: rowModel.height }}>
                <TimelineLabels
                  model={rowModel}
                  range={range}
                  facts={facts}
                  selectedEntity={selectedEntity}
                  focusKey={focusKey}
                  onToggle={actions.toggleTimelineEntity}
                  onSelect={onSelectRow}
                  onFocus={setFocusKey}
                />
              </div>
            </div>
          </div>
          <div className={styles.plotWrap}>
            <canvas ref={canvasRef} className={styles.canvas} data-testid="tl-canvas" />
            <div ref={tipRef} className={styles.tip} hidden data-testid="tl-tip" role="presentation" />
            <div ref={proxyRef} className={styles.scrollProxy} onScroll={(event) => plotRef.current?.scrollTo(event.currentTarget.scrollTop)} data-testid="tl-scroll">
              <div style={{ height: rowModel.height, width: 1 }} />
            </div>
            {status === "loading" && data.entities.length === 0 ? <div className={styles.empty}>Loading the history of the model…</div> : null}
            {status === "ready" && data.entities.length === 0 ? <div className={styles.empty}>This model has no entities.</div> : null}
          </div>
        </div>
      </div>
      <div className={styles.visuallyHidden} aria-live="polite" role="status" data-testid="tl-live">
        {live}
      </div>
    </section>
  );
}
