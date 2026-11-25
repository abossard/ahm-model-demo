# Contract requests

- WP6 (views): every View is over the 700 KB limit of architecture.md because of the kit baseline, not the View code. `hello.html` is 834 KB, `trader.html` 850 KB, `blackjack.html` 857 KB. Fonts are 141 KB; the rest is React, `ext-apps`, the MCP SDK and zod (the contracts barrel pulls every schema into each View). Workaround: none. Suggested: raise the limit to 900 KB, or import `@playground/contracts` by file in the kit. **Resolved**: limit is 900 KB in architecture.md.
# Contract requests

## WP1 Rules

- `CheckersView.captured`: the contract does not say which side the count belongs to. WP1 counts the pieces of that colour that were taken (`captured.white` is the number of white pieces black has captured). Say so in `contracts/src/checkers.ts` if the View reads it the other way. **Resolved**: comment added in the contract.
- `DealerFailure` carries no reason, so a misdeal after `"invalid"` logs `reply rejected: not usable`. `resolve` re-runs `validate` on a reply it is given, so a rejected reply that reaches `resolve` as a `DealerReply` logs the real problem (`reply rejected: KS is not left in the shoe`). The dealer runner should pass the last `DealerReply` and not `"invalid"` when it has one. **Resolved**.
- A full fuel tank has no notice code of its own. `refuel` answers it with `cargo_full` and the message "The tank is full." **Declined**: the message is clear, no new code.

## WP2 MCP server

- WP1 `checkers.ts` seats the house bot with id `bot`. `CheckersSeat.id` is a `PlayerId` (8 to 40 characters of `a-z0-9-`), and the MCP SDK validates every tool result against `outputSchema`, so `checkers_create` with `opponent: "bot"` and every later snapshot fail with "Invalid string" at `snapshot.view.seats.white.id`. Fix in WP1: give the bot an id of 8 or more characters (for example `house-bot`) and fix the architecture line. Workaround in `server.test.ts`: the test maps the id. **Resolved**.
- The dealer runner (WP2) now passes the last `DealerReply` to `resolve` when every attempt was rejected by `validate`, as WP1 asked, and `"invalid"` only when no reply ever arrived.

- WP5 (views): the host page must offer a theme toggle in the frame chrome. The lab exhibit `theme` is recorded only when a real `host-context-changed` with a new theme arrives, so without the toggle it can never be tried. Workaround: none, the other nine exhibits open layer 3. **Resolved**: the frame chrome has "View theme".
- WP5 (views): in a browser the host page failed to open a View with "Evaluating a string as JavaScript violates ... script-src 'self'" (zod's JIT in the host's MCP `Client`/`AppBridge` under the page policy). The host page needs `z.config({ jitless: true })` before it connects. Views already run jitless through `App`. **Resolved**: set in `host/src/web/wire/mcp.ts` and in `views/src/kit/connect.ts`.
- WP5 (views): every game View sends `updateModelContext({ structuredContent: { tableId } })` when the table changes, and `tableId: null` when it is in the lobby. The host should treat `null` as "no table". **Resolved**: `tableIdFromContext` returns null for it and the route is left alone.
