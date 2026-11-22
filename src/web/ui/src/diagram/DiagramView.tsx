import { useId, useState } from "react";
import { BranchFork20Regular, ChevronLeft16Regular, ChevronRight16Regular } from "@fluentui/react-icons";
import { edgeAppearance, tokensFor } from "../model/palette";
import { formatSignalValue } from "../model/signalValue";
import type { DiagramData, DiagramEntity } from "./data";
import { EntityCardHeading } from "../components/EntityCardHeading";
import { StateGlyph } from "../components/StateGlyph";
import "./diagram.css";

const PAGE_SIZE = 2;

function Connections({ anchor, neighbors, leaf, inspected }: {
  anchor: DiagramEntity; neighbors: readonly DiagramEntity[]; leaf: boolean; inspected: string;
}) {
  return <svg className="hm-diagram__edges" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true" focusable="false">
    {neighbors.map((neighbor, index) => {
      const child = leaf ? anchor : neighbor;
      const edge = edgeAppearance(child.healthState, child.impact, null);
      const x = (index + 0.5) * 100 / neighbors.length;
      const top = leaf ? x : 50;
      const bottom = leaf ? 50 : x;
      const path = `M${bottom} 28 C${bottom} 8 ${top} 20 ${top} 0`;
      return <g key={neighbor.name} fill="none" stroke={edge.stroke}>
        <path d={path} vectorEffect="non-scaling-stroke" strokeWidth={edge.width} strokeDasharray={edge.dash} strokeLinecap={edge.cap} />
        {child.impact !== "Suppressed" && (inspected === neighbor.name || inspected === anchor.name) &&
          <path key={inspected} className="hm-diagram__trace" d={path} pathLength="1" strokeWidth="2.6" strokeLinecap="round" />}
      </g>;
    })}
  </svg>;
}

function SignalList({ entity }: { entity: DiagramEntity }) {
  return <ul className="hm-diagram__signals">
    {entity.signals.map(signal => <li key={signal.name}>
      <span>{signal.displayName || signal.name}</span>
      <span className="hm-diagram__reading"><StateGlyph state={signal.healthState} size={12} />
        <span>{tokensFor(signal.healthState).word}</span>
        {signal.value !== null && <strong>{formatSignalValue(signal.value)}</strong>}
      </span>
    </li>)}
  </ul>;
}

function Branch({ anchor, neighbors, leaf, neighborCount = neighbors.length }: DiagramData & { anchor: DiagramEntity }) {
  const [selected, setSelected] = useState(anchor.name);
  const [page, setPage] = useState(0);
  const readingsId = useId();
  const lastPage = Math.max(0, Math.ceil(neighbors.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(lastPage, page);
  const offset = currentPage * PAGE_SIZE;
  const shown = neighbors.slice(offset, offset + PAGE_SIZE);
  const inspected = shown.find(entity => entity.name === selected) ?? anchor;
  const focus = anchor.displayName || anchor.name;
  const subject = inspected.displayName || inspected.name;
  const signalCount = inspected.signalCount ?? inspected.signals.length;
  const range = `${offset + 1}–${offset + shown.length} of ${neighborCount}`;

  function row(entities: readonly DiagramEntity[]) {
    return <div className="hm-diagram__row" data-single={entities.length === 1}>
      {entities.map(entity => {
        const label = entity.displayName || entity.name;
        const state = tokensFor(entity.healthState);
        return <button type="button" className="hm-diagram__node" key={entity.name} title={label}
          aria-pressed={entity.name === inspected.name} aria-controls={readingsId} onClick={() => setSelected(entity.name)}>
          <EntityCardHeading name={label}>
            <span className="hm-diagram__state" style={{ color: state.label }}><StateGlyph state={entity.healthState} size={13} />{state.word}</span>
          </EntityCardHeading>
        </button>;
      })}
    </div>;
  }

  return <>
    <div className="hm-diagram__stage" role="group" aria-label={`Inspect entities connected to ${focus}`}>
      {shown.length === 0 ? row([anchor]) : <>
        {row(leaf ? shown : [anchor])}
        <Connections anchor={anchor} neighbors={shown} leaf={leaf} inspected={inspected.name} />
        {row(leaf ? [anchor] : shown)}
      </>}
    </div>
    <div className="hm-diagram__relation">
      <span>{neighbors.length === 0 ? `${focus} has no connections.`
        : leaf ? `${neighborCount} ${neighborCount === 1 ? "entity depends" : "entities depend"} on ${focus}.`
        : `${focus} depends on ${neighborCount} ${neighborCount === 1 ? "entity" : "entities"}.`}</span>
      {lastPage > 0 && <div className="hm-diagram__pager" role="group" aria-label="Browse connections">
        <button type="button" disabled={currentPage === 0} aria-label="Previous connections" onClick={() => setPage(currentPage - 1)}><ChevronLeft16Regular /></button>
        <span>{range}</span>
        <button type="button" disabled={currentPage === lastPage} aria-label="Next connections" onClick={() => setPage(currentPage + 1)}><ChevronRight16Regular /></button>
      </div>}
      {neighborCount > neighbors.length && <span>Showing the first {neighbors.length} connections.</span>}
    </div>
    <div id={readingsId} className="hm-diagram__details" data-testid="diagram-readings" aria-live="polite" aria-atomic="true">
      {inspected.signals.length === 0 ? <span>{subject} has no direct signals.</span> : inspected.signals.length > 2 ?
        <details key={inspected.name}><summary>{subject} · {inspected.signals.length < signalCount ? `${inspected.signals.length} of ${signalCount}` : signalCount} signals</summary><SignalList entity={inspected} /></details> :
        <><strong>{subject} · {inspected.signals.length === 1 ? "Signal" : "Signals"}</strong><SignalList entity={inspected} /></>}
    </div>
  </>;
}

export function DiagramView({ diagram }: { diagram: DiagramData | null }) {
  const captionId = useId();
  return <figure className="hm-diagram" data-testid="health-model-diagram" aria-labelledby={captionId}>
    <figcaption id={captionId}><BranchFork20Regular /><strong>Dependency map</strong>{diagram?.timeLabel && <span>{diagram.timeLabel}</span>}</figcaption>
    {diagram?.anchor ? <Branch key={diagram.anchor.name} {...diagram} anchor={diagram.anchor} /> :
      <p>There are no entities to show here.</p>}
  </figure>;
}
