# Application Insights availability in the health model

Research date: 9 September 2026. Repository and primary-source investigation; no live Azure queries or deployment.
Updated 10 November 2026: the second availability test and its user flow no longer exist, and the signal query now uses `not(isnan(Value))`.

## Recommendation

Keep the existing native Log Analytics integration. The home page test already has a health-model signal in source. Add a separate signal for any further test that should contribute to health. Create a logical child entity if a test needs its own graph node.

Azure Monitor health models support Log Analytics queries that return a numeric value. A custom publisher or Azure Function is unnecessary for this workspace-backed telemetry. [Signal documentation][signals]

## Existing configuration

| Test | Execution | Health-model integration |
| --- | --- | --- |
| `Health Pulse home page` | Enabled GET of the public home page, every 300 seconds from three locations; retries enabled | `availability-test`, displayed as `Synthetic availability`, on `container-app` |

The test links to the Application Insights component. The component stores telemetry in the deployment's Log Analytics workspace. Sources: [availability test](../../infra/modules/availability-tests.bicep), [component and workspace](../../infra/modules/foundation.bicep).

The signal uses `properties.signalGroups.azureLogAnalytics.signals` with `signalKind: 'LogAnalyticsQuery'`. It reads `AppAvailabilityResults`, filters by the test name, and calculates the percentage of successful result rows. The signal turns Degraded below 100% and Unhealthy below 67%. The query contains `ago(15m)`, while `timeGrain` and `refreshInterval` both specify `PT5M`. Source: [signal configuration](../../infra/modules/health-model-entities.bicep), the `availability-test` signal of `container-app`.

The deployment passes the test name to the entity module through `availabilityTests.outputs.availabilityTestName`. It also supplies the workspace ID and the model's managed-identity authentication setting. The model identity receives Reader and Monitoring Reader on the resource group. Sources: [module wiring](../../infra/main.bicep), [model identity](../../infra/modules/health-model.bicep), [access grants](../../infra/modules/health-model-access.bicep).

Home page health contributes through `container-app` to `system-app-hosting`, then to all three user flows (View Health Model, Send Health Reports, Run agent tasks) and the model root. The parent entities use `WorstOf` with `ignoreUnknown: true`, so a home page failure reaches every flow. Sources: [entities](../../infra/modules/health-model-entities.bicep), [relationships](../../infra/modules/health-model-relationships.bicep).

## Problems to resolve before relying on the current signal

| Finding | Consequence and proposed action |
| --- | --- |
| KQL requests 15 minutes, but `timeGrain` specifies 5 minutes | The schema describes `timeGrain` as the signal's time range; the documentation says the configured query range limits retrieved records. Do not assume the effective window is 15 minutes. Align the settings with the intended window. [Signal settings][signals], [query schema][query-schema] |
| The query filters by `Name` alone | Another component with the same test name in a shared workspace could affect the result. Filter by both `_ResourceId` and the observed test `Name`. [Table reference][table] |
| The comment assumes an empty result means `Unknown` | Zero samples produce a NaN percentage; a valid NaN filter removes that row. The cited health-model contract asks for one numeric record but does not specify zero-row or stale-value behavior. Determine the runtime behavior before choosing a missing-data policy. [Kusto aggregation][summarize], [NaN behavior][isnan], [signal contract][signals] |
| The threshold measures observations, not failing locations | With three result rows and two successes, the value is 66.67%, which is unhealthy under the current threshold. Decide whether the desired policy is a success percentage or a location quorum. [Existing query](../../infra/modules/health-model-entities.bicep) |

Resolved since the first review: the query called `isnotnan(Value)`, which Microsoft's Kusto function registry lacks. It now uses the documented predicate `not(isnan(Value))`. [Function documentation][isnan], [function registry][functions]

These are source-level findings. The investigation did not determine whether the deployed signal executes or what state it reports.

## Adding another test

- Reuse the inline `LogAnalyticsQuery` pattern with the component ID and the emitted test name. Keep each test's availability separate from the home page calculation. `AppAvailabilityResults` includes `Name`, `_ResourceId`, `Success`, `Location`, `DurationMs`, and `TimeGenerated`, so KQL can express per-test percentages or a location-based policy. [Table schema][table]
- In [availability-tests.bicep](../../infra/modules/availability-tests.bicep), expose the test name so its definition and signal share one value. In [main.bicep](../../infra/main.bicep), pass it to the entity module. In [health-model-entities.bicep](../../infra/modules/health-model-entities.bicep), add the query to the entity it should affect, or create a logical child entity that carries it.
- For a child entity, add the relationship in [health-model-relationships.bicep](../../infra/modules/health-model-relationships.bicep), expose the new entity name, and update the declared entity and relationship counts.
- Where you attach a signal sets how far it propagates. A signal on `container-app` reaches every flow that depends on App Hosting. A signal on a flow's entity or on its child stays in that flow. Relationships support this logical aggregation; a log-backed entity needs no fabricated web-test resource kind. [Modeling concepts][concepts]
- For graph visibility, give each test a logical entity with its own query and connect it beneath the flow or system it observes. Move the home page signal if adopting this structure rather than keeping the same observation on both parent and child.

## Native metric alternative

Application Insights exposes `availabilityResults/availabilityPercentage` on the linked **`Microsoft.Insights/components` resource**, with namespace `microsoft.insights/components`, aggregation `Average`, and unit `Percent`. Its dimensions are `availabilityResult/name` and `availabilityResult/location`. Metric names use plural `availabilityResults`; dimension names use singular `availabilityResult`. [Metric catalog][metrics]

The web-test ARM resource defines the probe; it is not the source of that component metric. A metric signal must target the component ID, not the web-test ID or the Container App ID. [Web-test definition][webtests], [metric catalog][metrics]

Two constraints make KQL the simpler choice here:

- Each entity has one data source per signal type. The existing `container-app` Azure-resource group already targets the Container App for CPU, memory, and response-time metrics. A component-backed availability metric would need another entity. [Signal data sources][signals]
- The repository's Bicep uses `Microsoft.CloudHealth` with `2026-05-01-preview`. That contract exposes `dimensionFilter` but removes the older separate `dimension` property. The inspected description still refers to that removed property and does not specify the filter grammar. Verify per-test filtering before adopting metrics; do not copy older dimension/value examples. [Versioned schema][metric-schema]

This contract accepts both inline signal configuration and references through `signalDefinitionName`. Separate signal-definition resources are optional and add no benefit for a query that only one entity uses. [Signal-instance schema][instances]

## Visibility and discovery

The entity DTO carries each signal's current state and value. The history endpoint returns the history of the manual-report signal (`CANONICAL_SIGNAL_NAME`) and rejects every other query parameter. Showing availability history requires endpoint and UI work; a different query parameter will not enable it. Sources: [DTO](../../src/web/app/dto.py), [history endpoint](../../src/web/app/main.py).

Application Insights discovery covers topology and dependencies. The inspected documentation does not describe automatic creation of per-test availability signals. Configure those explicitly. Microsoft also documents duplicate entities from overlapping discovery. [Discovery documentation][discovery]

This repository enables recommended signals and relationship discovery. It creates a suppressed `discovered-app-topology` entity, but the discovery rule does not specify that entity as its parent. Inspect the resulting graph before assuming discovered entities cannot influence the root. Sources: [discovery rule](../../infra/modules/health-model-discovery.bicep), [relationships](../../infra/modules/health-model-relationships.bicep), [suppressed entity](../../infra/modules/health-model-entities.bicep).

## Evidence needed before deployment

Execute the current KQL against the intended workspace; inspect emitted names, component IDs, timestamps, and per-location counts. Compare the configured signal's value/history with the chosen query window. Determine no-data behavior and permissions using the model identity, then inspect the resulting relationship graph.

The existing [name-consistency test](../../tests/test_infra.py) only compares parameter defaults. It cannot show query validity or deployed behavior.

[signals]: https://learn.microsoft.com/en-us/azure/azure-monitor/health-models/signals
[table]: https://learn.microsoft.com/en-us/azure/azure-monitor/reference/tables/appavailabilityresults
[metrics]: https://learn.microsoft.com/en-us/azure/azure-monitor/reference/supported-metrics/microsoft-insights-components-metrics
[webtests]: https://learn.microsoft.com/en-us/azure/templates/microsoft.insights/2022-06-15/webtests
[isnan]: https://learn.microsoft.com/en-us/kusto/query/isnan-function?view=azure-monitor
[functions]: https://github.com/microsoft/Kusto-Query-Language/blob/master/src/Kusto.Language/Functions.cs
[summarize]: https://learn.microsoft.com/en-us/kusto/query/summarize-operator?view=azure-monitor
[query-schema]: https://github.com/Azure/azure-rest-api-specs/blob/main/specification/cloudhealth/resource-manager/Microsoft.CloudHealth/CloudHealth/main.tsp#L379-L398
[metric-schema]: https://github.com/Azure/azure-rest-api-specs/blob/main/specification/cloudhealth/resource-manager/Microsoft.CloudHealth/CloudHealth/main.tsp#L335-L376
[instances]: https://github.com/Azure/azure-rest-api-specs/blob/main/specification/cloudhealth/resource-manager/Microsoft.CloudHealth/CloudHealth/main.tsp#L909-L969
[concepts]: https://learn.microsoft.com/en-us/azure/azure-monitor/health-models/concepts
[discovery]: https://learn.microsoft.com/en-us/azure/azure-monitor/health-models/discoveries
