import type { JSX } from "react";
import { tokensFor } from "../model/palette";

interface StateGlyphProps {
  readonly state: string;
  readonly size?: number;
  readonly className?: string;
}

/**
 * The mark of a health state: a circle with a check, a triangle, a square with a cross, a dashed
 * ring, and for a retired entity a diamond. Each state has a shape of its own, so none rests on
 * colour alone. Decorative: the state is always named in text beside it.
 */
export function StateGlyph({ state, size = 12, className }: StateGlyphProps): JSX.Element {
  const token = tokensFor(state);
  const mark = { fill: "none", stroke: token.on, strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  let body: JSX.Element;
  switch (token.shape) {
    case "check":
      body = (
        <>
          <circle r="7" fill={token.dot} />
          <path d="M-3 0.3 L-0.6 2.8 L3.6 -2.3" {...mark} />
        </>
      );
      break;
    case "triangle":
      body = (
        <>
          <path d="M0 -6.8 L7.2 5.6 L-7.2 5.6 Z" fill={token.dot} stroke={token.dot} strokeWidth="2" strokeLinejoin="round" />
          <path d="M0 -2.2 V1.6" {...mark} />
          <circle cy="3.9" r="0.9" fill={token.on} />
        </>
      );
      break;
    case "square":
      body = (
        <>
          <rect x="-6.4" y="-6.4" width="12.8" height="12.8" rx="2.4" fill={token.dot} />
          <path d="M-2.6 -2.6 L2.6 2.6 M2.6 -2.6 L-2.6 2.6" {...mark} />
        </>
      );
      break;
    case "diamond":
      body = <path d="M0 -7.4 L7.4 0 L0 7.4 L-7.4 0 Z" fill={token.dot} stroke={token.dot} strokeWidth="1" strokeLinejoin="round" />;
      break;
    default:
      body = (
        <>
          <circle r="6.1" fill="none" stroke={token.dot} strokeWidth="1.9" strokeDasharray="3.4 2.6" />
          <text y="3.6" textAnchor="middle" fontSize="9.5" fontWeight="700" fill={token.dot}>
            ?
          </text>
        </>
      );
  }
  return (
    <svg className={className} viewBox="-8 -8 16 16" width={size} height={size} aria-hidden="true" focusable="false">
      {body}
    </svg>
  );
}
