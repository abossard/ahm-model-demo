export interface PingRow {
  at: number;
  roundTripMs: number;
  serverTime: number;
}

// A calculation: the newest few pings, newest first.
export function pushPing(rows: readonly PingRow[], row: PingRow, keep = 4): PingRow[] {
  return [row, ...rows].slice(0, keep);
}

export function clockTime(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(11, 19) + " UTC";
}

export function pingLine(pings: number): string {
  if (pings === 0) return "Nothing sent yet.";
  return pings === 1 ? "One ping counted by the server." : `${pings} pings counted by the server.`;
}
