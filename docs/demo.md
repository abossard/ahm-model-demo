# Demo guide

Open the web app link that `azd up` prints. The steps build on each other.

## Sign in

1. Select **Sign in with Microsoft** and use the account you use for Azure.
2. In **Choose your Azure directory**, select a verified directory and **Open workspace**. Expand **More Azure directories** to choose a membership that still needs an access check. Select it by name and choose **Check and open workspace**. Microsoft may ask for verification or consent. If Azure cannot list a directory, you can enter its domain, directory ID, or subscription ID. The workspace opens once Azure confirms access.
3. The account menu shows the selected directory. Models and resources come from subscriptions you can access there. Your Sessions belong to your account in that directory. Refreshing or opening a saved plan preserves the directory choice. To choose another directory, sign out and sign in again.

If your home organization blocks sign-in and another directory has invited you as a guest, open a saved link from the inviting directory. You can also use **Sign-in options** on the Microsoft sign-in page and enter the inviting organization's domain. [Microsoft guest sign-in](https://learn.microsoft.com/en-us/entra/external-id/redemption-experience#redemption-process-and-sign-in-through-a-common-endpoint).

If you can sign in but your home organization restricts directory lookup, expand **Find more directories**. Under **Directory for lookup**, choose a directory where you can use Azure and continue to Microsoft. After any required verification, select the workspace you want from the returned list.

Your directory's consent policy and your Azure roles decide what opens. Reader on a subscription or resource group lets you browse its models. Sending health reports, creating models and applying changes require additional permissions. [Azure access and consent](../infra/README.md#another-directory).

- **Design a model** is for the directory the app belongs to only. A user of another directory has no design model to write to.

## Create a health model

1. Choose **Create model** beside the model picker. Select resources individually or choose an entire resource group. Under **New model destination**, choose a suggested prefix based on your selection or enter your own. Select a destination group in the same subscription. The preview shows the full Azure resource name, including its unique suffix.
2. Run the analysis. In **Workload**, select a node in the dependency graph to inspect its role in the plan. **Why these choices were made** explains what came from Azure inventory, signal checks, user input or an assumption. Correct a resource's role or failure impact, or exclude it. To change the plan, enter an adjustment under **What should change?** and choose **Revise plan**. Review the updated graph and the changes in the same Session.
3. Choose **Confirm and suggest models**. Compare the proposed designs, open one, and inspect the graph, signals and coverage gaps. Download **plan.md** and **modelspec.md** from that preview. Both describe the selected design.
4. Review the destination and choose **Confirm creation in Azure**. The web app creates the model as you, writes its entities, relationships, signals and Designer positions, then reads them back. Open the model when creation finishes. If interrupted, reopen the builder Session from History and resume the same creation.

In **Workload**, expand **Analysis activity** to inspect a run. The first checks look up the platform metrics Azure Monitor publishes for each selected resource and read five-minute samples from the last 24 hours. A zero is a valid reading. If a check finds no usable sample, the activity explains whether Azure returned an empty series, required dimensions, or denied access. Expand a Foundry tool call to inspect its recorded result. The activity stays available when you reopen the Session.

Creating a model requires permission to write Azure Monitor health models in the destination group. After creation, **Signal access** lists each resource that supplies an enabled signal. Choose **Grant Monitoring Reader** to assign the role to the model's identity with your Azure account. Azure checks your permission to assign roles at each resource. The result for each resource stays in the Session, and you can retry a failed grant. Signals can show **Unknown** until Azure collects the next reading.

## Browse a model

- The graph opens `hm-<env>`: the root `Health Pulse`, three user flows, four system components and the Azure resources that hold the signals.
  See [Health models](../infra/README.md#health-models) for the topology.
- Right after `azd up`, entities read Unknown until their first evaluation, a few minutes after deployment.
- The **Health model** picker in the top bar lists every model you can read in every subscription of your directory, including `hm-<env>-design` when you can read it. A directory with none shows "No health models in your directory".
- Click an entity, in any view or in the search, to open the timeline on it (see **Read the history**). Above the plot it shows the entity with its state and impact, the question to ask about it, **Send a health report** and **State changes**, the list of every change of its state.
- Drag an entity to reorder it, in any view: a half-transparent copy follows the pointer and a dashed outline shows where it will snap, among the entities beside it under the same parent. **Order** then reads **Custom**: one order per model, kept in this browser and shown by every view; **Reset custom order** drops it. With the keyboard, **M** picks an entity up, the arrows move it, Enter drops it, Escape puts it back.
  In Cause path the chain to the root keeps its place. In Semantic zoom, ELK radial and the force layout swap two cards instead, and the live force layout keeps its free drag. Compare shows the order and has no drag.
- While a model is open the graph is live: a state change, or a new signal value, arrives within about half a minute and the node is outlined for a moment (and announced to a screen reader). The **Live** control in the top bar pauses and resumes it. **Refresh** reads the model by hand. Nothing is collected while nobody has the model open.

## Read the history

- **Timeline** in the top bar opens a panel under the graph, whatever view the graph shows. It also opens by itself when you click an entity: the row of that entity is selected, the way to it is open, its signals are open and the row is scrolled into view. Closing the timeline works; the next click on an entity opens it again. The button at the right of its header makes the timeline fill the window below the top bar; the button or Escape returns, and the address keeps it (`fullscreen=1`). The assistant's panel (History, a question with its steps and answer) opens over the full-screen timeline, on its left edge, and takes the focus; the toast that tells an answer is ready sits above it too. Escape closes the panel and returns the focus to where it was, and the next Escape leaves full screen.
- The left column is a tree of the relationships, not of layers. The roots are the entities without a parent; an open entity shows its signals first, then its dependencies, and each of those opens the same way. An entity with several parents is listed under each of them. An entity that relates to nothing comes last and says **Not connected**. Each entity row names its state; each signal row its state and its latest value with the unit, as of now or as of the selected moment.
- The bar of an entity fills its row: faint green for Healthy and faint grey for Unknown, strong orange for Degraded and strong red for Unhealthy, so trouble stands out. The line of a signal takes the same colours by its value: green while it is on the healthy side of the Degraded threshold, orange past it, red past the Unhealthy threshold, grey where the state is Unknown. The thresholds are drawn and named with their values, for example "Degraded above 70%". The legend above the tree names every colour and mark.
- Behind the line, a lane shows what state the signal exposed. The rule cuts the value axis into a healthy range (faint green), a degraded range (faint orange) and an unhealthy range (faint red), each only as tall as its values are on the lane, in the direction the rule compares (above or below its threshold). Where the signal had a state, the band of that state is stronger in that stretch of time: green where it was Healthy, red only where it was Unhealthy. A lane that a spike stretches keeps its green band as short as the healthy values are, and its red band shows only while the signal was Unhealthy. Unknown is a faint grey wash over the whole lane, and a signal without thresholds (a dynamic one, or one that reports states only) is washed over the whole lane in the colour of its state. The line and its dots stay the strongest marks.
- The strip above the tree is about the entity you work on: a click on an entity row, on a signal row (which picks the entity that has it), on a lane of the plot while a strip is open, or a move of the keyboard focus to another row selects that entity, and its row is outlined. Scrolling alone changes nothing; when the row of the selected entity is out of view the strip offers **Its row is out of view: show it**. The question names the entity, for example **Why is Session Storage Unhealthy?**; a long name is cut with an ellipsis and the full question is the tooltip.
- The chevron of a row opens one lane per signal. Lanes are read from Azure as they scroll into view.
- Scrolling moves through the rows, over the tree and over the plot alike. A pinch on a touchpad, or Control (Command on a Mac) and the wheel, zooms around the pointer. Scrolling sideways, or Shift and the wheel, moves in time. A swipe keeps the direction it starts in until it ends. A drag pans, Shift and drag (or a drag on the axis) zooms to a range, a double click shows the last 24 hours. The presets run from 1 hour to all history. The service keeps 30 days.
- Hover reads every lane at that instant and selects nothing. A click selects the instant: a line with its time at the top, and the whole page shows the model as it was then (see **Investigate a past moment**), with **Show on graph** for what was unhealthy. Drag the line or its label to move it; **Back to now** or Escape returns to now. Incidents (the root being Degraded or Unhealthy) are drawn under the axis, named when pointed at and listed under **Incidents** in the header; a click on one zooms to it.
- Diamonds are data annotations, flags are health reports and ticks are the state changes of the selected entity. The keyboard works too: left and right move the selected instant, with Shift to the state change before or after it in the focused row, up and down move between rows, Enter picks a row and opens or closes it, plus and minus zoom, space selects the instant under the pointer.
- **Live** keeps now at the right edge while new points arrive; dragging the plot away ends it. The address keeps the window, `?timeline=1&from=…&to=…`, or `?timeline=1&live=1&span=…` while it follows. What the timeline has read is kept in the browser, for the signed-in user only, so a reload paints at once and reads only what is new.

## Investigate a past moment

1. Open the **Timeline** and click in the plot where something went wrong, for example on the red part of an incident. A bar under the top bar says which time the page shows, "Showing 11 Nov 23:40:00, 2 h 10 min ago", and stays there in every view and when the timeline fills the window.
2. Everything now shows that moment. The graph, in whichever view, has the states, signal values, cause path and colours of then, the top bar the state the model had and "As of" the moment, the timeline tree the state and value of every row. Drag the line and the page follows.
   The entities and relationships are the ones the model has today: an entity that did not exist yet reads Unknown.
3. Click an entity. Its strip shows the state and impact it had, and the question is about then: **Why was Service A Unhealthy at 23:40?** One click asks it. History and the question name the moment, the answer says "State at 11 Nov 23:40" and that the state now may differ, and **Looked at** is the day before that moment.
   The assistant reads the model as it was at that instant, its history for the 24 hours before it and metrics and logs for the same window.
4. **Send a health report** is disabled: a report is about now. **Check this model** and **Design a model** in the **Ask** menu say "as it is now" and look at the model of now. **Compare now and after** returns the page to now, and selecting a moment closes the comparison.
5. **Back to now**, Escape, or closing the timeline returns to the live model. Changes that arrived meanwhile are on screen at once; they were not announced while you looked at the past.
6. The address names the moment, `&at=2026-11-11T22:40:00.000Z`, so a link or a reload shows the same moment in the same view.

## Send a health report

1. Click an entity of `hm-<env>`, such as `Session Storage`, then **Send a health report** above the plot. In the dialog, set **Report expires after (minutes)** to 30 or more.
   The assistant reads the report only while it is active, and the default is 1 minute.
2. Click **Unhealthy**. The quick-send buttons send a report with the form's value, expiry and reason. **Send report** sends the selected **State to report** instead.
3. The graph refreshes by itself 10 seconds after the app accepts the report. Refresh again to follow the state through `Session Store` and `Run agent tasks` to the root.

## Ask why an entity has its state

1. Click the entity that turned non-healthy, or the root `Health Pulse`. Above the plot it asks the question in the state it has: **Why is Service A Unhealthy?**, **Why is Service A Degraded?**, **Why is Service A Healthy?** or **Why is the state of Service A unknown?**. One click on it saves the question in History as "Why is <entity> <state>? (<date time>)", or adds it to the open topic when the assistant is not busy, and asks it.
   While the page shows a past moment the question is about that moment: see **Investigate a past moment**.
   To add a note for the assistant, click **Add a note** instead: the form opens with the question and the entity filled in, and sending it saves the question.
2. The panel opens on the question, and **What the assistant is doing** fills live: reading the health model, running queries, writing the answer. Each step is a plain sentence; the tool and its arguments are under the **...** button of the step, as **Technical details**.
   If you close the panel or leave the question, a notification offers **Show answer** when it is done.
   While the service is busy a step says "The assistant is busy, trying again (try 2 of 5, next try in 20 s)". If the assistant's last answer was rejected, the question lists what was wrong with it, and every problem is in the step's technical details.
3. When the assistant is done, the **Answer** tab opens by itself and takes focus. Its heading is the answer in one sentence, followed by the evidence and **What is behind it**: the chain from the asked entity down to the root cause, with each step's signal, threshold, value and how it is combined.
   When the assistant says so, the answer also shows **How sure** it is (High, Medium or Low, with what that means) and **Looked at**, the span of time it read, for example "the last 3 hours".
   The chain should end at the signal you reported. The graph marks the chain while the answer is open, and a step's name shows that entity on the graph. **What the assistant did** keeps every step.

Click **Show me** beside a finding to inspect the object it describes. A graph button can frame a node or trace a particular connection. A timeline button can expand an entity and highlight one signal across its label and plot. A panel button can open entity details, a proposed change, or the model comparison. The answer stays visible, including on a phone. Reopening a question from History restores its buttons and a historical Explain can take you back to the moment it describes.

In the builder, **Show me** opens a resource, its signal evidence, or a design preview beside the passage you clicked. You can inspect another proposal while keeping the current design selection. [Show me handles and local playground](../src/web/ui/src/showMe/README.md)

## Check a model

1. Put `hm-<env>` on screen. Click **Ask** in the top bar, then **Check this model**. The check starts at once, in the open topic or in a new one.
   The assistant works on one question at a time: a second ask says "The assistant is already working on something" and offers **Open it**. For a note, use **Ask something new** in a topic.
2. The **Proposed changes** tab shows how many changes are proposed, the summary, what the assistant found by severity (high, medium, low), the signal tests and the changes grouped by entity.
   Each change shows Add, Change or Remove, its kind (Entity, Signal definition or Relationship), its reason and its signal test chips (passed, failed, not run).
   **Applied together with** names the changes it needs, and the arrow beside a change lists its fields before and after.
3. A finding's **Select** button selects the changes that fix it. A failed signal test does not stop you from applying.
4. Switch on **Compare now and after** to see the model now and the model after the changes side by side with added, changed and removed entities marked. Click a node to select its changes. **Back to the model** returns to the graph.

## Apply a change

1. Select the changes you want. The bar counts them ("2 of 4 selected") and offers **Select all** and **Clear**.
   A selected change pulls in what it needs, and the bar lists what it added.
2. Click **Apply 2 changes**. The dialog, "Change the live model hm-<env>?", says it will write 2 changes to the live health model in Azure and that the app cannot undo it. Click **Apply 2 changes** again to write them, or **Cancel**.
3. The bar reports Applied, or Partly applied with the change where Apply stopped. Applied changes carry an **Applied** mark, and the graph reloads when the model is on screen.
4. Select another change and click Apply again. The first Apply changed the live model, so the app writes nothing and the bar says "The model changed since these changes were proposed".
   **Check again** checks the same model again at once.

## Design a model

1. Click **Ask** in the top bar, then **Design a model for my workload…**. The form opens without a topic; the topic is made when you send it. **Model for the design** shows `hm-<env>-design` and **Resource group of your workload** shows this deployment's. You cannot edit either.
   Paste a public GitHub repository URL into **GitHub repository (optional)** to let the assistant read its code.
2. Click **Design model**, read the proposed changes as in the check and use **Compare now and after**. The model now is the empty design model.
3. Click **Select all**, then **Apply N changes**, as in the Apply step. The dialog names `hm-<env>-design`. Pick `hm-<env>-design` in the **Health model** picker to see the result.

## Share a topic

The address names the model, topic and question on screen. Send it and any visitor opens the same question with what the assistant did.

## Side effects

| Action | What it changes | Undo |
|--------|-----------------|------|
| Health report | Adds a signal to one entity until it expires (1 to 120 minutes). | Expires on its own. |
| Task | Adds blobs to the `sessions` container and uses model tokens. The agent only reads Azure. | None. Sessions are never deleted. |
| Apply | Writes entities, signal definitions and relationships to a live model, as you, where your Azure role allows it. | None in the app. `azd provision` restores the Bicep-defined parts of this deployment's models. |

- A health report changes the state of the entity and its parents without touching the monitored resource.
  The root raises a Sev2 alert when it turns Unhealthy. Its action group has no receivers.
- Anyone with a Microsoft account can sign in, and a Task spends this deployment's model capacity. See the limits below for what bounds that.
- `azd provision` rewrites the Bicep-defined entities and relationships of `hm-<env>` and deletes nothing, so entities an Apply added stay.
- A Session left idle can lose the agent's memory of earlier Tasks and its sandbox files. Results and Activity timelines stay in Blob Storage.
- A web app restart fails running Tasks as `interrupted`.
- After you arrange or move entities in Azure Designer, save there and copy the exported coordinates into Bicep. Otherwise a later deployment can restore older positions.
  See [layout round-trip](../infra/README.md#designer-layout-round-trip).

## Limits of the public app

- A builder analysis accepts up to 32 resources after expanding the selected groups.
- A builder Task may correct a rejected plan twice. After the third rejection it stops and shows the last validation errors in Activity.

The caps are constants in `src/web/app/config.py`. A refused request carries the error code. Per user means per tenant and user: the same person in two directories is two users.

- 200 Sessions per user. A new Session beyond that returns `session_limit`.
- 50 Tasks per Session. The next Task returns `task_limit`: start a new Session.
- 1 Task running at a time per user, and 3 across the app. Another start returns `task_running` or `agents_busy`: try again in a few minutes.
- 6 live streams per user, 50 viewers per model and 8 models kept warm across the app.
- The timeline reads at most 120 signals, 400 Azure calls and 40 seconds per request, 8 calls at a time per request and 24 across the app. Beyond that it returns `too_many_series` or reports the series it skipped.
- Opening a model's timeline reads its missing history of the last 30 days in the background, with your sign-in: one fill a model and two across the app, 2 calls at a time a fill, 4 at a time and 300 a minute across the app, at most 8000 calls a fill, and only while no request waits for Azure. It stops at a 429 that three waits do not clear, after three failures in a row, or 2 minutes before your sign-in expires, and the next opening after 10 minutes starts it again.
- 64 KB per request body. A larger body returns `payload_too_large`.
- 10 minutes per Task. A longer Task fails with `timeout`.
- A question about a past moment reaches 30 days back, as far as the service keeps history, and 2 minutes ahead of the app's clock, which then counts as now. Any other moment returns `invalid_as_of`.
- After an Apply writes changes, a later Apply on the same Task returns `base_changed`.
- Health reports and Apply work only where your own Azure role allows them.

What stops one person from spending the model quota: one running Task per user, three across the app, the Task timeout, the caps above and the quota of the model deployment, which answers 429 beyond it. Set `ENTRA_ALLOWED_TENANTS` to the directories you trust to close the app to everyone else ([how](../infra/README.md#another-directory)). The list guards the web app only: the Azure MCP server takes a token of any directory ([accepted limit](../infra/README.md#azure-mcp-server)).

What does not: there is no limit per directory or in total money, so one directory can hold all three running Tasks, and a directory with many users gives each user the caps above. Sessions are never deleted, so storage grows with use. The closed history of the models users open, what they read, what the app reads ahead with their sign-in and what it records while they watch, is kept in this deployment's storage account for every directory's models. With the list empty, treat the app as open to anyone who can create a Microsoft account.
