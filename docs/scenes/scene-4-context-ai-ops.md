# Scene 4 — Context drives intelligent operations

**1:30–1:55.** Five shots. The brief flagged this as the least familiar scene, so each shot says
plainly what the demo can and cannot show.

## What is real here, and what is not

| Storyboard claim | Status |
|---|---|
| Health graph encodes architecture and dependencies | Real |
| Business requirements and operational context encoded | Real |
| Platform vs application distinction | Real |
| Correlated node pulses | Real |
| AI agent reasoning over health | Real, only when the optional copilot is deployed |
| Five specialised agents | **Not real** — there is one assistant |
| Automated remediation (rollback, reroute, restart) | **Not real** — the assistant stages a change for human approval and stops |

Shots 3 and 4 are therefore part product capture, part illustration. Don't imply the demo
auto-remediates; it doesn't, by design.

## Shot 1 — Unified health graph

*Grafana fades, leaving only the health model icon. From it grows a graph tree of entities. The
system stabilises into a glowing, structured dependency graph.*

1. Start on <img src="./icons/03528-icon-service-Monitor-Health-Models.svg" width="20" alt=""> [`Monitor-Health-Models`](./icons/03528-icon-service-Monitor-Health-Models.svg), the same icon that closed Scene 3, so the two scenes hinge on one object.
2. Grow the graph into the real topology, matching the portal's node positions. Cross-fade to the
   live graph on the stabilise beat so the two register exactly.

## Shot 2 — Failure interpretation split

*A node fails, health propagates, a separate correlated node pulses, the dependency chain lights up.
Split screen — left: platform issue; right: application issue. The system identifies which is
responsible.*

This is the demo's strongest structural argument and it is fully real.

1. **Right side, application issue.** Run `bash scripts/demo-failure.sh`. The database fails,
   propagation climbs to the root, and the platform node stays green throughout. Green platform plus
   red application is the on-screen verdict.
2. **Left side, platform issue.** The platform node watches Activity Log for service-health events,
   failed ARM operations and alert volume. Its impact is reduced so it reports without dragging the
   root down — deliberate, so a platform blip can't fake an application outage.
3. To move the left side without waiting for a real Azure incident, perform a genuinely failing
   management operation, then wait one refresh interval. Activity Log ingestion lags a few minutes.
4. On "the system automatically identifies which is responsible": what the model provides is the
   structural separation. The identification is the operator, or the assistant, reading it. Keep the
   voiceover on "distinguish between", which the graph does prove.

## Shot 3 — AI reasoning layer

*AI agents appear as extensions of the graph. One analyses, one investigates logs, one checks
dependencies, one opens deployment history, one suggests remediation.*

1. Open the demo app and click the assistant. It opens as a side drawer on desktop, a full-screen
   sheet on mobile.
2. There is **one** assistant, not five. Ask it things matching the storyboard's five roles: overall
   model health; why a node is unhealthy; what depends on the failed node; its recent transitions;
   what to do about it.
3. Film these as five turns in one conversation, then let the animation split them into five agent
   nodes. That's an honest abstraction of a real capability.
4. If the optional assistant isn't deployed, this shot is illustration only. Say so, rather than
   letting a mock-up imply a shipped multi-agent system.

## Shot 4 — Automated remediation

*Actions occur — rollback, reroute traffic, restart services, stabilise nodes.*

1. **The demo does none of these automatically.** The assistant stages a change and stops at an
   explicit approval showing exactly what will be sent. The operator approves. That is the whole
   action surface.
2. Truthfully filmable: the **restart** (the failure script really restarts the stopped database),
   the **stabilise** (it waits and confirms recovery held), and the **operator-approved action**
   (the approval card, then the state change that follows).
3. Rollback and traffic rerouting are not implemented. Animate them generically, or cut them.

## Shot 5 — Resolution state

*The graph compresses back into a calm, stable health model view. Camera zooms out and the graph
transforms into the glowing health model service icon.*

1. Film the tail of the failure script: every entity returning to green, held for the full stability
   window.
2. Confirm calm by re-running the entity listing from [README.md](./README.md) — every hand-authored
   entity back to `Healthy`.
3. Zoom out from the settled graph and dissolve into <img src="./icons/03528-icon-service-Monitor-Health-Models.svg" width="20" alt=""> [`Monitor-Health-Models`](./icons/03528-icon-service-Monitor-Health-Models.svg).
4. That icon is the first frame of Scene 5 — match its size and position.
