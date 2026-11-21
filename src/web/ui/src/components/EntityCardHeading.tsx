import type { ReactNode } from "react";
import { cardTokens, tokensFor } from "../model/palette";
import { StateGlyph } from "./StateGlyph";
import "./entityCardHeading.css";

const STROKE = `fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"`;

export const ICONS: Readonly<Record<string, string>> = {
  root: `<circle cx="12" cy="12" r="8.4" ${STROKE}/><path d="M4.2 12h3l2-3.6 2.8 7.2 1.8-3.6h4" ${STROKE}/>`,
  flow: `<circle cx="5.5" cy="6" r="2" ${STROKE}/><circle cx="5.5" cy="18" r="2" ${STROKE}/><circle cx="18.5" cy="12" r="2" ${STROKE}/><path d="M7.5 6h3a4 4 0 0 1 4 4M7.5 18h3a4 4 0 0 0 4-4" ${STROKE}/>`,
  web: `<circle cx="12" cy="12" r="8.4" ${STROKE}/><path d="M3.6 12h16.8M12 3.6c3 3 3 13.8 0 16.8M12 3.6c-3 3-3 13.8 0 16.8" ${STROKE}/>`,
  app: `<rect x="4" y="4.5" width="16" height="6" rx="1.2" ${STROKE}/><rect x="4" y="13.5" width="16" height="6" rx="1.2" ${STROKE}/><path d="M7.2 7.5h.01M7.2 16.5h.01" ${STROKE}/>`,
  db: `<ellipse cx="12" cy="6" rx="7" ry="2.8" ${STROKE}/><path d="M5 6v12c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8V6" ${STROKE}/><path d="M5 12c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8" ${STROKE}/>`,
  queue: `<rect x="4" y="5" width="16" height="3" rx="1" ${STROKE}/><rect x="4" y="10.5" width="16" height="3" rx="1" ${STROKE}/><rect x="4" y="16" width="10" height="3" rx="1" ${STROKE}/>`,
  ship: `<path d="M12 3.2l7.6 4.4v8.8L12 20.8l-7.6-4.4V7.6z" ${STROKE}/><path d="M4.6 7.8l7.4 4.3 7.4-4.3M12 12.1v8.6" ${STROKE}/>`,
  analytics: `<path d="M4 20h16" ${STROKE}/><path d="M6.5 20v-6M12 20V6.5M17.5 20v-9" ${STROKE}/>`,
  bolt: `<path d="M13 2.5 5.5 13.5H11l-1 8 8.5-12H12z" ${STROKE}/>`,
  cache: `<rect x="3.5" y="4" width="17" height="16" rx="2" ${STROKE}/><path d="M8 4v16M3.5 9.5h4M3.5 14.5h4" ${STROKE}/>`,
  shield: `<path d="M12 3l7 2.6v5.2c0 4.6-3 7.9-7 9.2-4-1.3-7-4.6-7-9.2V5.6z" ${STROKE}/><path d="M8.8 12.2l2.2 2.2 4-4.6" ${STROKE}/>`,
  cube: `<path d="M12 3.2l7.6 4.4v8.8L12 20.8l-7.6-4.4V7.6z" ${STROKE}/><path d="M4.6 7.8l7.4 4.3 7.4-4.3M12 12.1v8.6" ${STROKE}/>`,
};

export function pickIcon(label: string): string {
  const t = label.toLowerCase();
  const has = (...words: readonly string[]): boolean => words.some((word) => t.includes(word));
  if (has("root")) return "root";
  if (has("front door", "frontend", "web ", "website", "cdn", "web app")) return "web";
  if (has("api", "function", "serverless", "endpoint")) return "bolt";
  if (has("event", "grid")) return "bolt";
  if (has("cache", "redis")) return "cache";
  if (has("database", "sql", "cosmos", "db", "store", "storage")) return "db";
  if (has("queue", "message", "dead-letter", "service bus", "event hub", "hub")) return "queue";
  if (has("ship", "carrier", "logistics", "delivery", "sink")) return "ship";
  if (has("analytics", "report", "pipeline", "ingest", "index", "search", "batch", "scheduler")) return "analytics";
  if (has("security", "defender", "firewall", "waf", "auth", "identity", "entra", "key vault", "secret", "safety")) return "shield";
  if (has("container")) return "cube";
  if (has("model", "nested")) return "cube";
  if (has("app", "hosting", "compute", "vm", "worker", "processor", "agent", "tool")) return "app";
  if (has("shop", "commerce", "checkout", "catalog", "order", "payment", "fraud", "flow", "gateway")) return "flow";
  return "cube";
}

export function EntityCardHeading({ name, icon = pickIcon(name), children }: {
  name: string;
  icon?: string;
  children?: ReactNode;
}) {
  return <span className="entity-node__header">
    <span className="entity-node__icon" aria-hidden="true" style={{ color: cardTokens.muted }}>
      <svg viewBox="0 0 24 24" width="20" height="20"
        dangerouslySetInnerHTML={{ __html: ICONS[icon] ?? ICONS.cube! }} />
    </span>
    <span className="entity-node__name">{name}</span>
    {children}
  </span>;
}

export function EntityHealthPill({ state, predicted = false }: { state: string; predicted?: boolean }) {
  const token = tokensFor(state);
  return <span className="entity-node__pill" style={{ borderColor: token.border }}>
    <StateGlyph state={state} size={12} className="entity-node__dot" />
    <span className="entity-node__pill-word">{predicted ? "Predicted " : ""}{token.word}</span>
  </span>;
}
