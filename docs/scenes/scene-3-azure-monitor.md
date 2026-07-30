# Scene 3 — Health built into Azure Monitor

**0:55–1:30.** Five shots. The scene with the most product surface, and the one the brief asked the
most questions about.

## The eight signal sources — what this demo emits

Seven of the eight are live here. Icons are in [`icons/`](./icons/).

| Source | Live? | Where to film it | Icon |
|---|---|---|:---:|
| **Application Insights** | Yes | App Insights → Availability, and → Performance | <img src="./icons/00012-icon-service-Application-Insights.svg" width="26" alt=""> |
| **Log Analytics** | Yes | Log Analytics → Logs, run a signal's own query | <img src="./icons/00009-icon-service-Log-Analytics-Workspaces.svg" width="26" alt=""> |
| **Azure Metrics Explorer** | Yes | Any monitored resource → Metrics | <img src="./icons/00020-icon-service-Metrics.svg" width="26" alt=""> |
| **Azure Monitor workspace** | **No** | Not deployed. Icon and a stock blade only — don't imply it is wired here. | <img src="./icons/00001-icon-service-Monitor.svg" width="26" alt=""> substitute |
| **Resource Health** | Yes | Any monitored resource → Resource health | <img src="./icons/10004-icon-service-Service-Health.svg" width="26" alt=""> substitute |
| **Service Health** | Yes | Portal → Service Health | <img src="./icons/10004-icon-service-Service-Health.svg" width="26" alt=""> |
| **Azure Resource Manager** | Yes | Activity Log filtered to Administrative — those are ARM operations | <img src="./icons/10349-icon-service-Resource-Explorer.svg" width="26" alt=""> substitute |
| **Activity Log** | Yes | Portal → Activity Log | <img src="./icons/00007-icon-service-Activity-Log.svg" width="26" alt=""> |

**Direct answer to the brief:** icons exist for Application Insights, Log Analytics, Metrics
Explorer, Service Health and Activity Log. No dedicated icon exists for Resource Health, Azure
Resource Manager or Azure Monitor workspace — the substitutes above mean something else, so label
them. Health Models does have its own icon.

## Shot 1 — Ecosystem ingestion

*The Health Model sits at the centre, signals flow inward as streams rather than static icons.*

1. Centre <img src="./icons/03528-icon-service-Monitor-Health-Models.svg" width="20" alt=""> [`Monitor-Health-Models`](./icons/03528-icon-service-Monitor-Health-Models.svg).
2. Arrange the eight source icons around it. Mark the Azure Monitor workspace stream differently, or
   drop it — it's the one this demo can't demonstrate.

## Shot 2 — Model creation

*Zoom into the health model icon, transition to the Portal Designer, topology assembles into a
graph, nodes snap into place.*

1. Open the model → **Designer**. Node positions are fixed in code, so the layout is identical
   across takes.
2. For the "snapping into place" beat, use **Arrange**. It recomputes the layout live — real product
   behaviour, not an animation trick. Don't press Save unless you want the positions kept.
3. "Discovered automatically or defined explicitly" is literally true here: most entities come from
   infrastructure-as-code, and a discovery rule fills a topology node on its own. Showing both in
   one frame is a stronger shot than either alone.

## Shot 3 — Configuration in motion

*Configuration blade opens; signal cards attach to nodes, propagation paths light up, rules flow
through the graph, an alert lands on a node near the top.*

The four beats the brief called out, each mapping to something real:

1. **Signal cards attaching to nodes** — open the container app entity → **Signals**. Metric cards,
   log-query cards and a Resource Health baseline. Open one to show a real threshold.
2. **Propagation paths lighting up** — open a grouping entity and show its dependency aggregation,
   then show the two nodes whose impact is reduced so they can't drag the root down. That's why
   Scene 2 shot 4 only reddens one branch.
3. **Rules flowing through the graph** — evaluation rules are per signal. Pick ones whose numbers
   explain themselves, such as a database liveness check or an availability percentage.
4. **Alert applied to a node near the top** — open the root entity → **Alerts**. It's the only
   entity with one, which is the point of Scene 2 shot 5.

## Shot 4 — Investigation flow

*Switch between timeline view (event spike), graph view (same event on a node), entity detail view.
These are lenses on one health state, not separate features.*

1. Run `bash scripts/demo-failure.sh` first, or film within a couple of hours of a Scene 2 take, so
   there's a real spike to zoom into. An empty timeline has nothing to intersect.
2. **Timeline** → the outage appears as a band of red across the propagating entities.
3. **Vertical intersection → graph** — click into the timeline at the transition. A real gesture.
4. **Entity detail** — land on the failed database node and show its signal history.

## Shot 5 — Extensibility and export

*Zoom out, the Health Model icon again, health data flows outward into Grafana, custom tools and
partner systems as a structured health stream.*

1. Centre <img src="./icons/03528-icon-service-Monitor-Health-Models.svg" width="20" alt=""> [`Monitor-Health-Models`](./icons/03528-icon-service-Monitor-Health-Models.svg) again, for symmetry with shot 1.
2. Grafana: <img src="./icons/02905-icon-service-Azure-Managed-Grafana.svg" width="20" alt=""> [`Azure-Managed-Grafana`](./icons/02905-icon-service-Azure-Managed-Grafana.svg). No Grafana instance is deployed, so this is icon and stock footage.
3. "Custom tools" needs no stock footage — this demo is one. The app reads the model through the
   same public API and draws its own topology.
4. Film the app beside the portal. Same data, two consumers: the structured health stream
   demonstrated rather than asserted.
