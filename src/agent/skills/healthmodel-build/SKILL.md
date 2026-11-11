---
name: healthmodel-build
description: "Build and deploy an Azure Monitor health model from a plan: verify that every signal returns real data, pick the deployment method that fits the project (Bicep, Terraform AzAPI, az CLI or az rest), generate it, deploy after the user approves the exact change, and confirm the signals evaluate. Use whenever the user wants to create, implement, deploy or change a health model, its entities, signals, relationships, rollup or alerts, turn a healthmodel plan or modelspec into infrastructure code, or write and test a metric, KQL or PromQL health signal, even if they don't say 'build'."
---

# Build a health model

Turn an agreed plan into a working health model: every signal returns real data, the deployment fits the project, and nothing changes in Azure until the user says yes to the exact change.

## Where to look things up

Don't guess syntax, fields or commands. Look them up for the API version you use (`2026-11-01` unless the project pins another). [templates/main.bicep](templates/main.bicep) shows every building block once.

| What | Where |
|------|-------|
| Concepts, signals, rollup, permissions | [concepts](https://learn.microsoft.com/azure/azure-monitor/health-models/concepts), [signals](https://learn.microsoft.com/azure/azure-monitor/health-models/signals), [rollup](https://learn.microsoft.com/azure/azure-monitor/health-models/rollup), [permissions](https://learn.microsoft.com/azure/azure-monitor/health-models/create#permissions-required), [FAQ](https://learn.microsoft.com/azure/azure-monitor/health-models/health-models-faq) |
| Resource schema for Bicep, ARM and Terraform AzAPI | [healthmodels](https://learn.microsoft.com/azure/templates/microsoft.cloudhealth/2026-11-01/healthmodels), [entities](https://learn.microsoft.com/azure/templates/microsoft.cloudhealth/2026-11-01/healthmodels/entities), [relationships](https://learn.microsoft.com/azure/templates/microsoft.cloudhealth/2026-11-01/healthmodels/relationships), [signal definitions](https://learn.microsoft.com/azure/templates/microsoft.cloudhealth/2026-11-01/healthmodels/signaldefinitions), [authentication settings](https://learn.microsoft.com/azure/templates/microsoft.cloudhealth/2026-11-01/healthmodels/authenticationsettings) |
| REST operations, for `az rest`, PowerShell or any HTTP client | [REST API](https://learn.microsoft.com/rest/api/health-models/operation-groups) |
| CLI extension | [az monitor health-models](https://learn.microsoft.com/cli/azure/monitor/health-models), [CLI tutorial](https://learn.microsoft.com/azure/azure-monitor/health-models/cli) |
| A full Bicep example | [Bicep tutorial](https://learn.microsoft.com/azure/azure-monitor/health-models/tutorial-bicep) |
| Metric names per resource type | [supported metrics](https://learn.microsoft.com/azure/azure-monitor/reference/supported-metrics/metrics-index) |
| Running signal queries | [metrics CLI](https://learn.microsoft.com/cli/azure/monitor/metrics), [Log Analytics query API](https://learn.microsoft.com/azure/azure-monitor/logs/api/overview), [PromQL API](https://learn.microsoft.com/azure/azure-monitor/metrics/prometheus-api-promql) |
| Generic tools | [az rest](https://learn.microsoft.com/cli/azure/reference-index#az-rest), [Invoke-AzRestMethod](https://learn.microsoft.com/powershell/module/az.accounts/invoke-azrestmethod), [AzAPI provider](https://registry.terraform.io/providers/Azure/azapi/latest/docs), [deployment modes](https://learn.microsoft.com/azure/azure-resource-manager/templates/deployment-modes) |

Use the tools that are already there and install nothing: the core Azure CLI (`az rest`, `az deployment` and `az monitor metrics` need no extension), the `health-models` extension if installed (it pins an older preview API), Azure PowerShell, an Azure MCP server, or REST with an ARM token. If nothing can reach Azure, still write and validate the files, and hand over the commands.

## Workflow

Show the user where you are with a short checklist and keep it updated:

1. Read the plan
2. Verify signals
3. Choose how to deploy
4. Generate and validate
5. Get approval
6. Deploy
7. Confirm it works
8. Update the modelspec

A request can start in the middle (for example "test this KQL signal" or "deploy the reviewed Bicep"). Do the steps it needs and skip the rest.

### 1. Read the plan

The plan is usually `modelspec.md` and `plan.md` from `healthmodel-plan`; it can also be what the user said in the conversation. Collect the target scope, entities, relationships, rollup, signals and alerts, and check whether a model already exists (then this is an update: read it first).

Apply the plan's structure as it is: which flows, components and resources exist and how they connect is the plan's decision. If it looks wrong, say so and point to `healthmodel-plan` instead of redesigning it here.

Aim for a fully working model with little user intervention. Use the plan's values, including its assumptions. If a value is missing (threshold, window, impact, severity), choose a sensible default, record it as an `assumption` and continue. Ask only when the plan doesn't say what the model should cover; if there's no plan at all and the request is more than a single signal, suggest `healthmodel-plan` first.

Look up facts yourself: resource IDs, workspace IDs, metric names. Find the deployed workload from the project's deployment configuration and environment files, outputs of earlier deployments, then Azure itself (resource groups by name or tags, Resource Graph).

A failed or blocked lookup only blocks the steps that depend on it. Record the reason, take the next source, and keep doing everything else: write and validate the files, check the region, verify the signals you can reach.

### 2. Verify signals

A signal that returns nothing leaves its entity Unknown forever, and a wrong unit makes a threshold meaningless. Check every signal against the real data source before deploying. All of this is read-only.

- **Metric**: confirm the metric exists on the actual resource with the aggregation and time grain you need, then read its real values for the last day.
- **KQL**: run the exact query on the workspace. It must return one row with a number, also when nothing happened: a null value makes the signal Unknown in every quiet window (`summarize count()` without `by` returns 0). Azure uses only the first row.
- **PromQL**: run the exact instant query on the Azure Monitor workspace. Counters need `rate()`. Expect one series.

Watch for:

- **No traffic.** A count of 0 failures is healthy, also when there was no traffic; say whether there was traffic. A metric filtered to a value that never occurred (a 5xx or 429 dimension) has no data at all: swap it as described below.
- **Units.** `dataUnit` is only a label. Compare values and thresholds in the same unit (percent 0-100 vs ratio 0-1, ms vs s).
- **Would it fire today?** If an assumed threshold is already crossed by normal traffic, set it from the observed baseline and note the change. If it comes from a user commitment, keep it: crossing it is a real finding.
- **Your access isn't the model's access.** The model reads with its managed identity, which needs its own roles.
- Don't generate traffic or send health reports to make a signal look verified.

Show the results as a table:

| Signal | Source | Observed (last 24h) | Would be | Result |
|--------|--------|---------------------|----------|--------|
| failed-checkout-requests | law-prod | 0 to 3 per 5 min | Healthy, Degraded at peak | ✅ verified |
| api http-5xx | app-storefront | no datapoints | Unknown | ⚠️ no data yet |

If a signal can't work because its data doesn't exist (a custom event nobody sends, a metric the resource doesn't have, an empty table), swap in the closest signal on data that exists today: a platform metric of the resource, or the request, dependency or exception telemetry the app already writes. Keep the meaning and the user's thresholds where they still apply, record the swap as an `assumption`, and keep the original as a gap with the code change it needs. A model that evaluates beats one that waits for instrumentation.

If a resource isn't deployed or a read is denied, mark the signal unverified with the reason and keep going. The user decides whether to deploy unverified signals.

### 3. Choose how to deploy

Fit the project, so the health model lives where the rest of the infrastructure lives:

| The project has | Use | Why |
|-----------------|-----|-----|
| Bicep | A separate Bicep file next to the existing infra, e.g. `infra/healthmodel.bicep` | Reviewed like the rest; separate, so health model changes don't redeploy the app |
| Terraform | `azapi_resource` with the `Microsoft.CloudHealth` types | The azurerm provider has no health model resources |
| ARM JSON | ARM resources of the same types | Same as Bicep |
| No infrastructure code, or a one-off change | A saved script of REST calls, or the CLI extension for small changes | Repeatable and reviewable |

Pick the method that fits and say why in one line. Ask only if the user asked for something else or the project gives no hint at all.

If the plan names no target, use the workload's resource group and the nearest region where health models are available (`az provider show -n Microsoft.CloudHealth` lists them), and record it as an `assumption`. The docs suggest a different subscription or region from the monitored resources, so the model keeps reporting when they fail; mention it in the approval.

### 4. Generate and validate

Start from [templates/main.bicep](templates/main.bicep) and the plan's IDs, and check every property against the schema reference. The traps the reference doesn't make obvious:

- **Root entity**: created with the model and named like it. Don't declare a second root; relationships point to it by name.
- **Icons**: set `icon.iconName` to `UserFlow` for the plan's user flows and `SystemComponent` for its system components, the same choices the portal offers.
- **Resource entities**: bind `azureResourceId` to the resource as it's listed in its resource group (an account, a database, a search service), not to a technical child path of it such as `.../default` that only groups metrics; use the metrics that resource offers, and name a sub-resource in the display name instead. Give it a technical display name that identifies the resource, and the sub-resource where it matters, and is unique in the model (e.g. `Azure SQL: orders`), with the actual names filled in.
- **One data source per signal group type per entity**: for a second workspace, add a child entity.
- **Signal definitions**: editing one changes every entity that uses it, and per-entity threshold overrides aren't documented, so use a separate definition for different thresholds.
- **Permissions**: Azure grants the model identity nothing. Add its role assignments explicitly; they are a separate line in the approval.
- **Alerts**: notify through the action group the plan or the user names. If none is named, configure the alerts without action groups and list routing as open. Never pick an existing action group by guess; someone else may own it, or it may notify nobody.
- **Bicep**: there are no float literals, so write `json('99.9')`. Local Bicep may lack CloudHealth types (warning BCP081); then `bicep build` only checks syntax.
- Avoid `Dynamic` thresholds until they're documented for your API version.

Updating an existing model:

- Read the current configuration first and keep what you aren't asked to change.
- A PUT (and every Bicep or Terraform resource) writes the whole resource, so properties you leave out are reset.
- Resources missing from a template are not deleted. Deletions are explicit operations, ordered so relationships go before entities and entities before the definitions they use.
- Discovered entities (`discoveredBy`) belong to discovery rules and can't be deleted manually.

Validate before asking: `bicep build`, `terraform validate` (if already initialized) or a dry review of the script. If available, run a what-if or `terraform plan`: it reads Azure but changes nothing, and gives the user the exact diff.

### 5. Get approval

This is the one point where the user always steps in. Use this shape, so nothing is left out, and always end with the question:

```markdown
**Deploy health model `<name>`**

- Target: <subscription> / <resource group> / <region>
- Method: <file>, `<exact command>`
- Creates: <n> entities (<names>), <n> relationships, <n> signals. Changes: <names or none>. Deletes: <names or none>
- Role assignments: <role> on <scope>, one per line
- Alerts: <entity> notifies <action group> (<receivers>), or "no routing yet"
- Assumptions:
  - <target, changed thresholds, swapped signals, defaults>
- Unverified: <signals and why, or none>
- Starts Unknown: <n> of <m> signals. <parent> can show Healthy while <children> are Unknown, because worst-of doesn't count Unknown children

Deploy this to `<resource group>` now? (yes/no)
```

The approval covers exactly this change. If the files, parameters, target or method change afterwards, ask again. In a non-interactive run, ask the question anyway and stop there, without deploying.

### 6. Deploy

- Use the existing login and tools; pass the subscription and resource group explicitly on every call.
- Run only what was approved. On the first error, stop, show it, and propose a fix rather than retrying or trying something else.
- Don't log in, install tools or extensions, run `terraform init`, or make any change that wasn't in the approved summary.

### 7. Confirm it works

Provisioning `Succeeded` means the configuration was saved, not that health is evaluated.

- Read back the model, entities and relationships (CLI extension or REST API) and compare them with what you deployed.
- Wait for the first evaluation (the refresh interval plus a few minutes; new role assignments can take longer), then read each signal's `status`: `healthState`, `value`, `reportedAt`, `error`.
- An `error` mentioning authorization means the model identity lacks a role or it hasn't propagated yet.
- Show a final table of entity, signal, state, value and error, and a small top-down mermaid diagram colored by state. Mark anything still pending as unknown rather than healthy, and say when a green parent rests on only a few known children.

### 8. Update the modelspec

If there is a modelspec, update only the affected rows:

- **Signals**: fill Verification with the observed result or the reason it couldn't be verified, set Status to `done` or `problem: <reason>`.
- **Entities**: Status `done` once deployed and evaluating.
- **User input and decisions**: the deployment method and the approval, with time and who approved.
- **Shared source material**: verification runs and deployment results as new `S<n>` entries (command, scope, time).

Keep the reply short: what was verified, what was deployed, what's left. Don't repeat the files.

## Rules that keep the user safe

- Reads (queries, metric lists, what-if, plan) are fine within the agreed scope.
- Writes need the user's yes to that exact change: deployments, role assignments, deletions, health reports (they create or overwrite a signal), discovery rules.
- Don't invent health meaning, and don't silently rename, swap or drop signals: every change shows up in the summary.
