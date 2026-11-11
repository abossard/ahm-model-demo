# Demo guide

Open the web app link that `azd up` prints. The steps build on each other.

## Browse a model

- The graph opens `hm-<env>`: the root `Health Pulse`, three user flows, four system components and the Azure resources that hold the signals.
  See [Health models](../infra/README.md#health-models) for the topology.
- Right after `azd up`, entities read Unknown until their first evaluation, a few minutes after deployment.
- The **Health model** picker in the top bar lists every model the web app can read, including `hm-<env>-design`.
- Click an entity to open its panel with its state, impact, state transitions and report history. **Refresh** and **Auto-refresh** follow state changes.

## Send a health report

1. Click an entity of `hm-<env>`, such as `Session Storage`. Under **Report health**, set **Expires in (minutes)** to 30 or more.
   An Explain task reads the report only while it is active, and the default is 1 minute.
2. Click **Unhealthy**. The quick-send buttons send a report with the form's value, expiry and reason. **Submit report** sends the selected **Health state** instead.
3. The graph refreshes by itself 10 seconds after the app accepts the report. Refresh again to follow the rollup through `Session Store` and `Run agent tasks` to the root.

## Explain a state

1. Click the entity that turned non-healthy, or the root `Health Pulse`, then **Explain this entity** in its panel. The Session workspace opens.
   With no Session open, type an optional title and click **New session**. The **New task** tab then shows **Explain** selected and the entity filled in.
2. Add a Task instruction if you like and click **Start Explain**. The workspace opens Explain #1 and its Activity timeline fills live: loading a skill, inspecting the model, running queries.
3. When the Task finishes, the **Result** tab opens by itself. It shows the entity's state, a summary and the cause chain.
   The chain runs from the asked entity down to the root cause, with each step's signal, threshold, value and rollup.
   The chain should end at the signal you reported. The graph marks the chain while the result is open, and a step's name shows that entity on the graph.

## Review a model

1. Put `hm-<env>` on screen. Click **Sessions** in the top bar, open or create a Session, open the **New task** tab, select **Review** and click **Start Review**.
   A Session runs one Task at a time. A Task instruction is optional.
2. The **Result** tab shows the summary, the findings by severity (high, medium, low), the Verification summary and the changes grouped by entity.
   Each change shows Add, Change or Remove, its kind (Entity, Signal definition or Relationship), its reason and its Verification chips.
   **Applies with** names the changes it needs, and the arrow beside a change lists its fields before and after.
3. A finding's **Select** button selects the changes that fix it. A failing Verification does not block Apply.
4. Switch on **Compare** to see the Base model and the Proposed model side by side with added, changed and removed entities marked. Click a node to select its changes. **Exit compare** returns to the graph.

## Apply a change

1. Select the changes you want. The bar counts them ("2 of 4 selected") and offers **Select all** and **Clear**.
   A selected change pulls in what it needs, and the bar lists what it added.
2. Click **Apply 2 changes**. The dialog names the live model and warns that the app cannot undo an Apply. Click **Apply 2 changes** again to write them, or **Cancel**.
3. The bar reports Applied, or Partly applied with the change where Apply stopped. Applied changes carry an **Applied** mark, and the graph reloads when the model is on screen.
4. Select another change and click Apply again. The first Apply changed the live model, so the app writes nothing and the bar says "The model changed after this Review".
   **Start a new Review** opens the New task tab with Review selected.

## Design a model

1. Open a Session's **New task** tab and select **Design**. **Target model** shows `hm-<env>-design` and **Workload resource group** shows this deployment's. You cannot edit either.
   Paste a public GitHub repository URL into **Repository (optional)** to let the agent read its code.
2. Click **Start Design**, read the result as in the Review and use **Compare**. The Base model is the empty design model.
3. Click **Select all**, then **Apply N changes**, as in the Apply step. The dialog names `hm-<env>-design`. Pick `hm-<env>-design` in the **Health model** picker to see the result.

## Share a Session

The address names the model, Session and Task on screen. Send it and any visitor opens the same Task with its Activity timeline.

## Side effects

| Action | What it changes | Undo |
|--------|-----------------|------|
| Health report | Adds a signal to one entity until it expires (1 to 120 minutes). | Expires on its own. |
| Task | Adds blobs to the `sessions` container and uses model tokens. The agent only reads Azure. | None. Sessions are never deleted. |
| Apply | Writes entities, signal definitions and relationships to a live model in this resource group. | None in the app. `azd provision` restores the Bicep-defined parts. |

- A health report changes the state of the entity and its parents without touching the monitored resource.
  The root raises a Sev2 alert when it turns Unhealthy. Its action group has no receivers.
- The app has no sign-in. Anyone with the URL can read every Session and Apply.
- `azd provision` rewrites the Bicep-defined entities and relationships of `hm-<env>` and deletes nothing, so entities an Apply added stay.
- A Session left idle can lose the agent's memory of earlier Tasks and its sandbox files. Results and Activity timelines stay in Blob Storage.
- A web app restart fails running Tasks as `interrupted`.
- After you arrange or move entities in Azure Designer, save there and copy the exported coordinates into Bicep. Otherwise a later deployment can restore older positions.
  See [layout round-trip](../infra/README.md#designer-layout-round-trip).

## Limits of the public app

The caps are constants in `src/web/app/config.py`. A refused request carries the error code.

- 200 Sessions in the app. A new Session beyond that returns `session_limit`.
- 50 Tasks per Session. The next Task returns `task_limit`: start a new Session.
- 3 Tasks running at once across the app. Another start returns `agents_busy`: try again in a few minutes.
- 64 KB per request body. A larger body returns `payload_too_large`.
- 30 minutes per Task. A longer Task fails with `timeout`.
- After an Apply writes changes, a later Apply on the same Task returns `base_changed`.
- Health reports work only where the web identity holds the report role. By default that is `hm-<env>`.
