import { lazy, Suspense, useMemo } from "react";
import { diagramData } from "../diagram/data";
import type { HealthModelSnapshot } from "../model/types";

const DiagramHost = lazy(() => import("../diagram/DiagramHost"));

export function HealthModelDiagram({ model, entityName, timeLabel }: {
  model: HealthModelSnapshot; entityName?: string | null; timeLabel?: string;
}) {
  const diagram = useMemo(() => diagramData(model, entityName, timeLabel), [model, entityName, timeLabel]);
  return <Suspense fallback={<p role="status">Opening dependency map…</p>}><DiagramHost diagram={diagram} /></Suspense>;
}
