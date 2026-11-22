# Show me

An assistant can place a button beside a sentence in its answer. Clicking the button opens the destination and outlines it while the answer stays on screen. Reopening the answer restores the buttons. The user can choose which one to follow.

A small vocabulary covers many destinations. The handle identifies a surface. The ID identifies an object on that surface using names from the same Task’s evidence.

| Handle | Example IDs | What opens |
| --- | --- | --- |
| `graph` | `node/orders-api`, `connection/orders-api-orders-db`, `view/coverage` | An entity in the current layout, the actual relationship path with both endpoints in view, or an entire layout. The browser can switch to Semantic zoom to draw a missing target. |
| `timeline` | `overview`, `entity/orders-api`, `signal/orders-api/order-errors` | The timeline or the exact row and plotted lane. The tree expands and scrolls to the row. An Explain restores its saved moment. |
| `panel` | `entity/orders-api`, `change/c3`, `comparison` | Entity details, one expanded proposed change, or the saved Base and Proposed models. Inspection leaves the Apply selection alone. |
| `builder` | `resource/R1`, `signal/R1`, `design/planned-workload` | A read-only inspector beside the source passage in the MCP App. Resource references belong to that Task’s inventory. A design ID comes from that turn’s proposals. |

The workspace advertises up to three handles. A builder turn advertises one. Each describes the ID forms supported by that turn. A phone stacks the answer and the chosen graph, timeline or builder destination vertically.

## A turn from start to click

1. At Task start the browser calls `registry.describe()`. Each entry has a unique `name`, a description of the destination, and an `idDescription`. For `graph` this names the entity and relationship fields in the model data and lists the allowed layouts. An empty description of the ID means the handle takes no ID.
2. The web app stores this snapshot as `showMeHandles` on the Task and sends it to the hosted agent. Its `show_me` tool accepts a handle from this turn and two possible arguments, `id` and `highlight`. For example, the agent can request `{"handle":"graph","id":"node/orders-api","highlight":{"color":"amber","label":"Failed order checks"}}`.
3. The tool returns a marker such as `[[show:1]]`. The agent inserts it beside the relevant words in a summary, cause, finding, change reason, builder decision or design trade-off. For example, “Order errors exceeded the threshold. [[show:1]] The database remained healthy.” The accepted result stores the referenced actions in its own `showMe` map. The HTTP and Task result contracts cover the field limits and validation. [Task contract](../../../../../docs/redesign/plan.md)
4. `ShowMeText` renders a native button at that position. Rendering or restoring a result has no navigation side effect. Clicking resolves its saved action through the browser's registered callback, using the Task's model and checking that the ID still exists. A missing destination gives feedback beside the button. Previously saved handle names still resolve. The host can also link structured evidence in older answers.

## Offer next steps

A saved answer can include a `nextSteps` array with two or three choices. Each choice names an action that `show_me` prepared for this Task. If the tool returned `[[show:2]]`, the choice uses the string `"2"` as its `id`. The browser renders its `label` on the button. Clicking opens the destination using the same registry as an inline button.

```tsx
import { ShowMeNextSteps } from "./showMe/NextSteps";

<ShowMeNextSteps registry={registry} actions={actions} choices={[
  { id: "1", label: "Inspect the migration" },
  { id: "2", label: "See release history" },
]} />
```

For a branching tour, import `NextSteps` from the same module and pass `choices` and `onChoose(id)`. Each id can identify a tour stop. The host opens that stop and supplies its next choices. Both components use a labelled group of keyboard-accessible buttons.

## Add a destination

The host owns navigation. Register a callback that validates its domain ID, reveals its destination, and returns the mounted `Element`. Return `null` if the target has disappeared. Keep the chat mounted when changing a page or opening details. The playground uses a nonmodal dialog so its answer stays interactive.

```ts
import { createShowMe } from "./showMe";

const registry = createShowMe([{
  name: "release",
  description: "Inspect the selected release.",
  idDescription: "history, or check/<id> from this release’s checks.",
  open: (id, signal) => id === "history" ? openReleaseHistory()
    : id?.startsWith("check/") ? openReleaseCheck(id.slice(6), signal) : null,
}]);

// At the start of a user turn
const showMeHandles = registry.describe();
```

Only descriptions travel to the agent. The callback stays in the browser. For a destination that mounts asynchronously, return a promise and check the supplied `AbortSignal` before committing a delayed reveal. A second click supersedes the first. The registry owns one outline and optional short text label, handles scrolling, and removes its annotation on `clear()`. Call `clear()` when the answer closes or the destination changes identity.

The core uses TypeScript, DOM APIs and a stylesheet. The optional React component takes `text`, the saved action map and a registry. A `renderText` callback lets the host keep its existing typography. The descriptions and action map are plain data. Looking up an ID, loading a model and moving a viewport belong to the host. The shared registry handles cancellation, annotation lifetime and the result of a click. A guided tour can call the same `registry.execute(action)` for each user-selected step, advance on `"shown"`, handle `"unavailable"` and call `clear()` on exit. The tour owns its own order. [Core](./index.ts) · [React button](./ShowMeText.tsx) · [Workspace registrations](../store/workspaceShowMe.ts) · [Builder inspector](../builder/BuilderAnswer.tsx)

## Local playground

Run the Vite development server from the repository root.

```sh
npm --prefix src/web/ui run dev -- --host 127.0.0.1 --port 4286
```

Open the playground, click the two buttons in the saved example reply, and try **Walk through the checks**. It uses the same renderer and registry as the workspace. Expand **Handles for this turn** to inspect what the frontend advertises. The playground runs locally without an account or agent. [Open the playground](http://127.0.0.1:4286/examples/show-me/) · [Example source](../../examples/show-me/example.tsx)

Run the following browser checks from the repository root. The first exercises the standalone module on phone and desktop. The second sends a real Task request to the local Python app, runs the scripted agent, reloads its saved result, and hit-tests the destination and answer.

```sh
npm --prefix src/web/ui run e2e -- --config examples/show-me/playwright.config.ts
npm --prefix src/web/ui run e2e -- --config playwright.real.config.ts --grep "Show me advertises"
```

## Existing frameworks

| Option | What it supplies | Fit for this feature |
| --- | --- | --- |
| CopilotKit | Registers browser tools with typed parameters and can render tool UI in chat. | Closest fit for agent-side discovery. Its handler normally runs when the agent calls it. This app already has a hosted tool runtime and a Session result store, and needs navigation deferred until the reader clicks. [Frontend tools](https://docs.copilotkit.ai/reference/hooks/useFrontendTool) |
| Driver.js | Highlights individual elements and drives guided sequences with popovers and step callbacks. | Useful when a product needs a tour player. The app still has to define which entity IDs exist and how a saved answer references them. [Driver.js configuration](https://driverjs.com/docs/configuration) |
| Shepherd | Attaches a step to a target, waits for the destination to open, and supports Back, Next and custom actions. | Useful for ordered onboarding with asynchronous navigation. A finding in this app needs one independent, repeatable action. [Shepherd usage](https://docs.shepherdjs.dev/guides/usage/) |

The workspace uses its existing Task transport and a self-built registry. The builder View uses the same registry inside its MCP Apps iframe. Opening an inspector resolves IDs from that Task and calls the existing preview tool for a proposed design. [MCP Apps quickstart](https://apps.extensions.modelcontextprotocol.io/api/documents/Quickstart.html)
