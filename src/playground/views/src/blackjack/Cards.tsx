import type { CSSProperties } from "react";
import { cardFace, cardTransitionName, chipStack, type CardFace, type Owner } from "./logic";

const SUIT_PATH: Record<NonNullable<CardFace["suit"]>, string> = {
  S: "M12 2C9 7 4 9.5 4 14a4 4 0 0 0 7 2.6c-.1 2-.7 3.6-2 5.4h6c-1.3-1.8-1.9-3.4-2-5.4A4 4 0 0 0 20 14c0-4.5-5-7-8-12z",
  H: "M12 21C6 16.5 3 13.3 3 9.5A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 9 2.5C21 13.3 18 16.5 12 21z",
  D: "M12 2l7 10-7 10-7-10z",
  C: "M12 3a4 4 0 0 0-3.4 6.1A4.5 4.5 0 1 0 11 16.3c-.1 2-.7 3.7-2 5.7h6c-1.3-2-1.9-3.7-2-5.7a4.5 4.5 0 1 0 2.4-7.2A4 4 0 0 0 12 3z",
};

function Suit({ suit }: { suit: NonNullable<CardFace["suit"]> }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={SUIT_PATH[suit]} fill="currentColor" />
    </svg>
  );
}

// `name` is its view-transition-name: the card flies from the shoe once, then moves with its seat.
export function Card({ code, name }: { code: string; name: string }) {
  const face = cardFace(code);
  const style = { viewTransitionName: name, viewTransitionClass: "card" } as CSSProperties;
  if (face.hidden) return <span className="card card-back" style={style} role="img" aria-label={face.label} data-card="??" />;
  return (
    <span className={`card ${face.red ? "card-red" : ""}`} style={style} role="img" aria-label={face.label} data-card={code}>
      <span className="card-corner"><b>{face.rank}</b><Suit suit={face.suit!} /></span>
      <span className="card-pip"><Suit suit={face.suit!} /></span>
    </span>
  );
}

export function Hand({ cards, owner, size = "seat", testId }: { cards: readonly string[]; owner: Owner; size?: "seat" | "dealer"; testId?: string }) {
  return (
    <span className={`hand hand-${size}`} data-testid={testId} data-count={cards.length}>
      {cards.map((code, i) => <Card key={`${i}-${code}`} code={code} name={cardTransitionName(owner, i)} />)}
    </span>
  );
}

export function ChipStack({ amount, name }: { amount: number; name: string }) {
  const stacks = chipStack(amount);
  if (stacks.length === 0) return null;
  return (
    <span className="chips-stack" aria-hidden="true" style={{ viewTransitionName: name, viewTransitionClass: "chips" } as CSSProperties}>
      {stacks.map(({ value, count }) => (
        <span className="pile" key={value}>
          {Array.from({ length: count }, (_, i) => <i key={i} className={`disc disc-${value}`} style={{ bottom: `${i * 3}px` }} />)}
        </span>
      ))}
    </span>
  );
}

// A face-up chip for the bet buttons.
export function Disc({ value }: { value: number }) {
  return <i className={`disc disc-${value} disc-flat`} aria-hidden="true" />;
}
