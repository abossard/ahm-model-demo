import { useEffect, useMemo, useState } from "react";

// A calculation. The server's deadline, read on this machine's clock: both clocks are compared once, at receipt.
export function secondsLeft(deadline: number, serverTime: number, receivedAt: number, now: number): number {
  const skew = serverTime - receivedAt;
  return Math.max(0, Math.ceil((deadline - (now + skew)) / 1000));
}

export function ago(updatedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

// Whole seconds until `deadline`, ticking while there is one. `serverTime` is the snapshot's.
export function useCountdown(deadline: number | null, serverTime: number): number | null {
  const receivedAt = useMemo(() => Date.now(), [serverTime]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [deadline, serverTime]);
  return deadline === null ? null : secondsLeft(deadline, serverTime, receivedAt, now);
}
