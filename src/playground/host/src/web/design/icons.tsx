import type { LayerId } from "@playground/contracts";

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export function LockIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" {...stroke}>
      <rect x="5" y="11" width="14" height="9" rx="1" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

export function ArrowIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" {...stroke}>
      <path d="M4 12h15M13 6l6 6-6 6" />
    </svg>
  );
}

// One flat graphic per layer, drawn with the layer's own hue. They sit in the corner of a panel and carry no information.
export function Motif({ layer }: { layer: LayerId }) {
  const props = { viewBox: "0 0 160 120", "aria-hidden": true, className: "motif", ...stroke, strokeWidth: 2.5 } as const;
  switch (layer) {
    case 1:
      return (
        <svg {...props}>
          <rect x="14" y="14" width="132" height="92" rx="2" />
          <path d="M14 34h132" />
          <path d="M60 58l0 34 10-9 8 18 8-4-8-17 14 0z" fill="currentColor" stroke="none" />
        </svg>
      );
    case 2:
      return (
        <svg {...props}>
          {Array.from({ length: 10 }, (_, i) => (
            <circle key={i} cx={28 + (i % 5) * 26} cy={42 + Math.floor(i / 5) * 32} r="9" fill={i < 3 ? "currentColor" : "none"} />
          ))}
        </svg>
      );
    case 3:
      return (
        <svg {...props}>
          {Array.from({ length: 16 }, (_, i) => {
            const x = i % 4, y = Math.floor(i / 4);
            return (x + y) % 2 === 0 ? <rect key={i} x={36 + x * 22} y={16 + y * 22} width="22" height="22" fill="currentColor" stroke="none" /> : null;
          })}
          <rect x="36" y="16" width="88" height="88" />
          <circle cx="58" cy="82" r="8" fill="#0D0F14" /><circle cx="102" cy="38" r="8" fill="#F2EDE2" stroke="none" />
        </svg>
      );
    case 4:
      return (
        <svg {...props}>
          <path d="M24 88L52 40L84 70L112 26L138 62M84 70L70 104" />
          {[[24, 88], [52, 40], [84, 70], [112, 26], [138, 62], [70, 104]].map(([x, y]) => <circle key={`${x}${y}`} cx={x} cy={y} r="6" fill="#0D0F14" />)}
        </svg>
      );
    case 5:
      return (
        <svg {...props}>
          <ellipse cx="80" cy="64" rx="64" ry="40" />
          <rect x="52" y="44" width="26" height="36" rx="3" transform="rotate(-10 65 62)" fill="#0D0F14" />
          <rect x="82" y="44" width="26" height="36" rx="3" transform="rotate(8 95 62)" fill="currentColor" />
        </svg>
      );
  }
}
