# MCP App Playground: vision

A public page, no sign-in, where a visitor learns MCP Apps by using them. It starts with one button and ends at a
blackjack table with strangers and a language model dealing. Every message that crosses the wire is on screen the
whole time. The build contract is [architecture.md](architecture.md).

## The promise

- You never read about a message you cannot see. The wire drawer shows both hops, live, on every layer.
- You start small. Using a layer is what opens the next one.
- Every layer is a real MCP App: a tool, a `ui://` View, a sandboxed frame, JSON-RPC over `postMessage`. Nothing is faked for the demo.
- The MCP server is public too. A visitor can point another MCP Apps host at it and get the same Views.

## The five layers

| # | Name | What the visitor does | What it teaches | The job that opens the next layer |
|---|------|-----------------------|-----------------|-----------------------------------|
| 1 | Briefing | Reads four short panels, calls `hello_show`, presses a button inside the View | A tool can name a View. The host reads it as a resource and renders it in a sandbox. A View reaches the server only through the host. | Press the button inside the View (`hello_ping`). |
| 2 | The Lab | Flips ten exhibits: call a tool, read a resource, stream progress, message the host, update model context, open a link, change display mode, log, follow the theme, offer a tool of its own. Calls any tool by hand in the tool runner. | The whole surface of `App` and `AppBridge`, one request at a time. Model-visible tools against app-only tools. | Try any three exhibits (`lab_checkpoint`). |
| 3 | Checkers | Plays the house bot, or a second person through an invite link | Shared state on the server, versions, and turns that arrive without a refresh | Take a piece. |
| 4 | Drift Ledger | Flies six ports for thirty days: buy low, burn fuel, sell high | A long single-player game held in server state. A View that only renders snapshots. | Sell cargo for more than you paid. |
| 5 | Blackjack | Sits at a six-seat table with other visitors. A language model shuffles and plays the dealer's hand. | Many players, deadlines, and a model whose every reply is checked before it counts | Win a hand. The career is complete. |

Rules of the ladder:

- A layer never locks again.
- The server decides: `advanceCareer` in `src/playground/contracts/src/career.ts` runs in the MCP server when a tool call is the job. The career is stored per player and returned in the tool result's `_meta["playground/career"]`.
- The browser keeps a copy in `localStorage` (`playground.career`) so the ladder paints at once. `career_get` corrects it on load. The higher of the two wins on screen, the server copy wins on the next call.
- Cheat code, in the spirit of the genre: type `opencity` anywhere on the page. It calls `career_cheat` and opens all five layers. The Briefing says so in its last line: "In a hurry? Type OPENCITY."
- A locked layer shows its name, its lock and the job that opens it. A deep link to a locked layer lands on the ladder with that rung highlighted.

## The offer

The moment a job is done:

1. The tool result arrives with the new career. The wire drawer shows it like any other message.
2. A band crosses the stage from the left, once: `LAYER 3 OPEN` in the display face, then the name, `CHECKERS`. 900 ms in, holds 1.6 s, leaves. With reduced motion it fades.
3. The rung on the ladder turns from duotone to full colour.
4. An offer card stays under the View: one line on what the visitor just did ("You called a tool from inside a View."), one line on what is next ("Next: two people, one board, and turns the server pushes."), a primary button `Go to Checkers` and a quiet `Stay here`.

Nothing navigates on its own. The visitor is never moved off a View they are using.

## Art direction

Night city, seen from the dispatcher's desk. The reference is the genre's loading-screen collage and its heads-up display, not its crime. Flat, graphic, legible.

**Layout**

- Home is a collage of five panels with thick ink gutters, uneven sizes, the top-left the largest. Locked panels are duotone with a lock and the job. Open panels are in colour.
- A layer page has three zones: the ladder (a narrow rail on the left, five numbered plates), the stage (the View in a frame), the wire (a drawer on the right).
- The frame around a View is honest chrome: it names the `ui://` resource, the tool that opened it, and the sandbox it runs in (`origin null`, `connect-src 'none'`). It is a rectangle with a 2 px ink border, not a card with a shadow.
- Under 900 px the ladder becomes a top strip and the wire a bottom sheet.

**Type**

- Display: Big Shoulders Display, 800 and 900, upper case, tight. Layer names, the unlock band, panel titles, numbers on the ladder.
- Text: Instrument Sans, 400 and 600. Body at 16 px, never below 14 px.
- Wire and data: JetBrains Mono, 12.5 px in the drawer, tabular figures everywhere a number changes.
- Fonts ship in the bundle. No request leaves the origin.

**Colour**

- Ground `#0D0F14` (ink), raised `#161A22`, lines `#2A3040`.
- Paper `#F2EDE2` for text, `#A9A294` for secondary text. Both pass 4.5:1 on the ground.
- One signal colour for anything live or newly open: sodium `#FF9A1F`.
- One hue per layer, used for its panel, its plate and its View accents only: mint `#5FE3B0`, cyan `#58C7F3`, signal red `#F2545B`, violet `#9A8CFF`, felt `#2FA36B` with brass `#D9B45B`.
- Wire colours carry meaning and nothing else uses them: view→host cyan, host→view violet, host→server sodium, server→host mint, errors signal red.
- Dark only for the shell. The Lab's theme exhibit flips the hello and lab Views to light to show `host-context-changed`.
- No gradients on surfaces, no glass, no glow. Depth comes from borders and overlap.

**Motion**

- One big moment: the unlock band. Everything else is small and fast: 120 to 200 ms, ease-out, opacity and transform only.
- A new wire row slides in 8 px and its lane arrow draws in 150 ms. While the drawer is paused nothing moves.
- Cards deal along a short arc, 220 ms each, staggered 70 ms. A checkers piece slides, a captured piece drops out.
- `prefers-reduced-motion` turns every one of these into a fade.

**The wire drawer**

- Always there. Closed, it is a chip at the bottom right: a small radar sweep, the message count, and a blink per message. `` ` `` or a click opens it.
- Open, it is a ladder diagram: three lanes, View, Host, Server, time running down. Each message is an arrow between two lanes with its method, id, size and, for a reply, its time.
- A click on an arrow opens the message below it: pretty JSON, the HTTP exchange that carried it, the trace it belongs to, copy buttons for the message and for a `curl` that replays it.
- Controls in one row: pause, clear, filter by hop, by kind, by text, "this trace only", "hide long-polls", copy all as JSON.
- A request with no reply yet shows a running timer. A long-poll is the plainest picture of how a turn arrives.

**Game Views**

- Checkers: a board that fills the frame, ink and paper squares, red and bone pieces, legal moves as rings.
- Drift Ledger: a star chart of six ports on the left, the market as a ledger on the right, fuel and hold as two plain gauges.
- Blackjack: a felt oval from above, six seats on the near edge, the dealer opposite, chips as stacked discs. Beside it, "the dealer's mind": each call to the model with its time and whether its reply was accepted.

## Voice

- Second person, present tense, short. Verbs first: "Call the tool", "Watch the wire", "Take a seat".
- Dry, never loud. One wry line per screen at most. No slang, no crime, no exclamation marks.
- Name the mechanism: "The View asked the host to call `checkers_move`. The host asked the server." Not "magic happens".
- Errors say what happened and what to do: "The table closed while you were away. Pick another."
- The dealer's table talk comes from the model, is capped at 120 characters and is shown in quotes as the dealer's.

Sample lines:

- Briefing: "This rectangle is a web page the server sent. It cannot reach the network. It can only talk to this page."
- Lab: "Ten switches. Flip three."
- Checkers, waiting: "Waiting for white. Send the link, or let the house play."
- Blackjack, shuffling: "The dealer is shuffling. That is a language model putting cards in order."
- Misdeal: "Misdeal. The dealer's reply did not survive the check. All bets returned."
- Career complete: "That is every layer. The wire has no more secrets from you."

## Done means

- A first-time visitor reaches blackjack in under ten minutes without reading documentation.
- At any moment they can answer "what just went over the wire?" by looking right.
- Two browsers at one table see each other's moves in under a second.
- It holds up as a design: a screenshot of any layer is recognisably this product and no other.
