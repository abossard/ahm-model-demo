import type { BlackjackView } from "@playground/contracts";
import { ChipStack, Hand } from "./Cards";
import type { CSSProperties } from "react";
import { clockFraction, seatBadge, seatTransitionName } from "./logic";

const named = (name: string, kind: string) => ({ viewTransitionName: name, viewTransitionClass: kind }) as CSSProperties;

interface Props {
  index: number;
  view: BlackjackView;
  remaining: number | null;
}

export function Seat({ index, view, remaining }: Props) {
  const seat = view.seats[index] ?? null;
  const you = view.you === index;
  if (!seat) {
    return (
      <div className="seat seat-empty" data-testid={`seat-${index}`} data-state="empty">
        <span className="seat-ghost">Seat {index + 1}</span>
      </div>
    );
  }
  const turn = view.phase === "players" && view.turn === index;
  const badge = seatBadge(seat, view, index);
  const showBet = seat.bet > 0;
  return (
    <div className="seat" data-testid={`seat-${index}`} data-state={seat.state} data-outcome={seat.outcome ?? ""} data-you={you} data-turn={turn}>
      {you && <span className="you">You</span>}
      <div className="seat-hand">
        <Hand cards={seat.cards} owner={index} />
        {seat.cards.length > 0 && <span className="num total" data-testid={`total-${index}`}>{seat.total}</span>}
      </div>
      <div className="seat-bet">
        {showBet ? <><ChipStack amount={seat.bet} name={seatTransitionName("stack", index)} /><span className="num bet-amount" style={named(seatTransitionName("bet", index), "num")}>{seat.bet}</span></> : <span className="bet-none">No bet</span>}
      </div>
      <div className="seat-name">
        <span className="who">{seat.handle}</span>
      </div>
      <div className="seat-foot">
        <span className="num" style={named(seatTransitionName("chips", index), "num")}>{seat.chips.toLocaleString("en-US")}<span className="of"> chips</span></span>
        {badge && <span className={`badge badge-${badge.tone}`} data-testid={`badge-${index}`}>{badge.text}</span>}
      </div>
      {turn && <i className="clock" style={{ transform: `scaleX(${clockFraction("players", remaining)})` }} aria-hidden="true" />}
    </div>
  );
}
