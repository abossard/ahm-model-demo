# View kit

Everything a View needs of the host and the server. A View's `main.tsx` is one line:

```tsx
launch("blackjack", "Blackjack", ({ app, player, first }) => <Table app={app} player={player} first={first} />);
// launch(name, title, ...): `title` shows only while connecting or when the host never answers.
```

`launch` imports the fonts, tokens and kit styles, sets `data-view` (the layer hue) and `data-theme`, connects, and renders your component with a `ViewContext`:
`{ app, args, first, theme, player }`. `first` is the entry tool's result: `outputOf<"blackjack_open">(first)` gives it a type.

## API (import from `../kit`)

| Name | Use |
|------|-----|
| `launch(name, title, Component, options?)` | Boot. `options.capabilities` for views that offer tools (`{ tools: {} }`). |
| `connect(name, options?)` | What `launch` calls. Handlers are registered before `app.connect()`. Theme changes are applied for you. |
| `call(app, name, args, { signal, timeout, onprogress }?)` | Typed `callServerTool`. Throws with the result's text on `isError`. |
| `outputOf<N>(result)` | The typed `structuredContent` of a result you already hold. |
| `useTable(app, player, initial)` | `{ snapshot, notice, error, busy, offline, act, leave }`. See below. |
| `useHostContext(app)` | The host context (theme, display mode), re-read on change. |
| `useCountdown(deadline, serverTime)` | Whole seconds left, ticking, corrected for clock skew. `null` without a deadline. |
| `Frame`, `Button`, `NoticeBar`, `Lobby` | The shared look. `Frame` caps the View at 1600 px and scrolls inside. Its `title` is optional and normally left out: the host's chrome already names the layer. |
| `log.debug/info/warn/error(msg, fields?)` | One JSON line per call on the console: `{ t, level, view, msg, ...fields }`. |
| `fixtureApp(answers)` (from `./testing`) | An `App` that answers from recorded outputs, for tests and fixtures. |

`useTable`:

- `initial` is `outputOf<"x_open">(first).snapshot`. The first open's `lobby` and `notice` stay with you.
- `act(name, args)` calls the tool and takes `snapshot` and `notice` from the answer. `args` is `ToolInput<N>`, so it includes `player` and, for table tools, `tableId`.
- Following is automatic while a table is open: `wait_for_change` again after each answer, backing off 1, 2, 5 s on failure. An older version never replaces a newer one.
- `updateModelContext({ structuredContent: { tableId } })` is sent for you whenever the table changes (`null` after `leave`).
- `leave()` stops following and clears the snapshot. Show your lobby, then `act("x_create" | "x_join", ...)`.
- `notice` clears itself after 6 s. `error` is only for a server that could not serve.

## Look

- `tokens.css`: ink ground, paper text, sodium for anything live, one hue per View through `var(--accent)`. `[data-theme="light"]` flips them.
- Display face for names and big numbers (`var(--font-display)`, upper case), text face for reading, `var(--font-mono)` for data. Numbers are tabular by default.
- Buttons: `variant` `primary` (accent fill), `plain`, `quiet`, `danger`. `busy` shows the sweep and disables the button.
- Test ids of the lobby: `lobby-create`, `lobby-create-bot` (your `actions[].testid`), `lobby-row`.
- Do not use `vh` for height: the frame resizes to its content.
