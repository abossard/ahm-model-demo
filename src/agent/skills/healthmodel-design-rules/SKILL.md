---
name: healthmodel-design-rules
description: "Rules for the entities and signals of a health model proposal: what a signal is verified against, the traps of resource entities, and how to update an existing model. Use for every Design and Review change."
---

# Rules for the entities and signals you propose

## Signals

- A signal that returns nothing leaves its entity Unknown. Run every new or changed signal against its real data first. All of it is read-only.
- Metric: the metric exists on that resource with that aggregation and time grain, and returns values for the last day.
- KQL: run the exact query. It returns one row with a number, also when nothing happened: `summarize count()` without `by` returns 0. Only the first row counts.
- PromQL cannot be run here: mark it `not_run`.
- `dataUnit` is only a label. Compare values and thresholds in the same unit (percent 0-100 or ratio 0-1, ms or s).
- If normal traffic already crosses a threshold, set it from the observed baseline and say so in the `reason`.
- If the data does not exist (an empty table, a metric the resource does not have), use the closest signal on data that exists today and keep its meaning.
- Never generate traffic or send health reports to make a signal pass.

## Resource entities

- The root entity exists already and is named like the model: relationships point to it by name, never add a second root.
- Icons: `UserFlow` for user flows, `SystemComponent` for system components.
- Bind `azureResourceId` to the resource as it is listed in its resource group, not to a child path such as `.../default`.
- One data source per signal group type per entity: for a second workspace, add a child entity.
- A signal definition is shared: editing it changes every entity that uses it. Use a separate definition for another threshold.
- Alerts only with an action group the instruction names. Never guess one. Avoid `Dynamic` thresholds.

## Updating an existing model

- Read the entity first and keep what you are not asked to change: a write replaces the whole resource.
- Missing resources are not deleted. A deletion is an explicit `remove`, and removing an entity needs a `remove` for every relationship that names it.
- Discovered entities (`discoveredBy`) belong to discovery: they cannot be changed or removed.
