# Application Insights availability in the health model

Research date: 9 September 2026. Repository and primary-source investigation; no live Azure queries or deployment.

## Recommendation

Keep the existing native Log Analytics integration. The homepage test already has a health-model signal in source. Add a separate, conditional signal for the request journey if that test should contribute to health. Create logical child entities if the tests need their own graph nodes.

Azure Monitor health models support Log Analytics queries that return a numeric value. A custom publisher or Azure Function is unnecessary for this workspace-backed telemetry. [Signal documentation][signals]

## Existing configuration

| Test | Execution | Health-model integration |
| --- | --- | --- |
| `Health Pulse home page` | Enabled GET of the public homepage, every 300 seconds from three locations; retries enabled | `availability-test`, displayed as `Synthetic availability`, on `container-app` |
| `Health Pulse request journey` | POST to `/api/demo-request`; disabled by default because it writes to Queue Storage and PostgreSQL | No signal |

Both tests link to the same Application Insights component. The component stores telemetry in the deployment's Log Analytics workspace. Sources: [availability tests](../../infra/modules/availability-tests.bicep), [component and workspace](../../infra/modules/foundation.bicep).

The existing homepage signal uses `properties.signalGroups.azureLogAnalytics.signals` with `signalKind: 'LogAnalyticsQuery'`. It reads `AppAvailabilityResults`, filters by the homepage test name, and calculates the percentage of successful result rows. Its thresholds are degraded below 100% and unhealthy below 67%. The query contains `ago(15m)`, while `timeGrain` and `refreshInterval` both specify `PT5M`. Source: [signal configuration](../../infra/modules/health-model-entities.bicep#L389-L415).

The deployment passes the test name to the entity module through `availabilityTests.outputs.availabilityTestName`. It also supplies the workspace ID and the model's managed-identity authentication setting. The model identity receives Reader and Monitoring Reader on the resource group. Sources: [module wiring](../../infra/main.bicep), [model identity](../../infra/modules/health-model.bicep), [access grants](../../infra/modules/health-model-access.bicep).

Homepage health contributes through `container-app` to `system-app-hosting`, then to all four user flows and the model root. The parent entities use `WorstOf` with `ignoreUnknown: true`. This placement makes homepage failures relevant to more than the request journey. Sources: [entities](../../infra/modules/health-model-entities.bicep), [relationships](../../infra/modules/health-model-relationships.bicep).

## Problems to resolve before relying on the current signal

| Finding | Consequence and proposed action |
| --- | --- |
| The query calls `isnotnan(Value)` | Microsoft's Kusto function registry contains `isnan`, but no `isnotnan`. Unless the workspace defines that function, the query is likely invalid. Use the documented predicate `not(isnan(Value))`. [Function documentation][isnan], [function registry][functions] |
| KQL requests 15 minutes, but `timeGrain` specifies 5 minutes | The schema describes `timeGrain` as the signal's time range; the documentation says the configured query range limits retrieved records. Do not assume the effective window is 15 minutes. Align the settings with the intended window. [Signal settings][signals], [query schema][query-schema] |
| The query filters by `Name` alone | Another component with the same test name in a shared workspace could affect the result. Filter by both `_ResourceId` and the observed test `Name`. [Table reference][table] |
| The comment assumes an empty result means `Unknown` | Zero samples produce a NaN percentage; a valid NaN filter removes that row. The cited health-model contract asks for one numeric record but does not establish zero-row or stale-value behavior. Determine the runtime behavior before choosing a missing-data policy. [Kusto aggregation][summarize], [NaN behavior][isnan], [signal contract][signals] |
| The threshold measures observations, not failing locations | With three result rows and two successes, the value is 66.67%, which is unhealthy under the current threshold. Decide whether the desired policy is a success percentage or a location quorum. [Existing query](../../infra/modules/health-model-entities.bicep#L389-L415) |

These are source-level findings. The investigation did not establish whether the deployed signal executes or what state it reports.

## Adding the journey test

Reuse the inline `LogAnalyticsQuery` pattern, with the component ID and the emitted name `Health Pulse request journey`. Keep its availability separate from the homepage calculation. `AppAvailabilityResults` includes `Name`, `_ResourceId`, `Success`, `Location`, `DurationMs`, and `TimeGenerated`, so KQL can express per-test percentages or a location-based policy. [Table schema][table]

Recommended implementation points:

1. In [availability-tests.bicep](../../infra/modules/availability-tests.bicep), expose the journey test name so its definition and signal share one value.
2. In [main.bicep](../../infra/main.bicep), pass that name and `journeyAvailabilityTestEnabled` to the entity module.
3. In [health-model-entities.bicep](../../infra/modules/health-model-entities.bicep), add the journey query to `request-journey`, or create a logical child entity carrying it. Gate the signal or entity with the same enablement flag.
4. If creating a child, add the flow-to-test relationship in [health-model-relationships.bicep](../../infra/modules/health-model-relationships.bicep), expose the new entity name, and update the declared entity/relationship counts.

Attaching journey health to `request-journey` confines its contribution to that flow. Putting it on shared `container-app` would affect every flow that depends on App Hosting. Choose that propagation scope before implementation. Relationships support this logical aggregation; a log-backed entity needs no fabricated web-test resource kind. [Modeling concepts][concepts]

For graph visibility, give each test a logical entity with its own query and connect it beneath the flow or system it observes. Move the existing homepage signal if adopting this structure rather than keeping the same observation on both parent and child.

## Native metric alternative

Application Insights exposes `availabilityResults/availabilityPercentage` on the linked **`Microsoft.Insights/components` resource**, with namespace `microsoft.insights/components`, aggregation `Average`, and unit `Percent`. Its dimensions are `availabilityResult/name` and `availabilityResult/location`. Metric names use plural `availabilityResults`; dimension names use singular `availabilityResult`. [Metric catalog][metrics]

The web-test ARM resource defines the probe; it is not the source of that component metric. A metric signal must target the component ID, not the web-test ID or the Container App ID. [Web-test definition][webtests], [metric catalog][metrics]

Two constraints make KQL the simpler choice here:

- Each entity has one data source per signal type. The existing `container-app` Azure-resource group already targets the Container App for CPU, memory, and response-time metrics. A component-backed availability metric would need another entity. [Signal data sources][signals]
- The repository uses `Microsoft.CloudHealth` with `2026-05-01-preview`. That contract exposes `dimensionFilter` but removes the older separate `dimension` property. The inspected description still refers to that removed property and does not establish the filter grammar. Verify per-test filtering before adopting metrics; do not copy older dimension/value examples. [Versioned schema][metric-schema]

Both inline signal configuration and references through `signalDefinitionName` are supported in this contract. Separate signal-definition resources are optional and add no benefit for two distinct queries unless other entities reuse them. [Signal-instance schema][instances]

## Visibility and discovery

The custom app includes current signals in its entity DTOs, but its detail panel does not render the signal list. Its history endpoint and UI use the manual-report `CANONICAL_SIGNAL_NAME`. Showing availability history requires endpoint and UI work; a different query parameter will not enable it. Sources: [DTO](../../src/web/app/dto.py#L78-L111), [entity panel](../../src/web/ui/src/components/EntityPanel.tsx), [history UI](../../src/web/ui/src/components/SignalHistory.tsx), [history endpoint](../../src/web/app/main.py#L486-L575).

Application Insights discovery covers topology and dependencies. The inspected documentation does not establish automatic creation of per-test availability signals. Configure those explicitly. Microsoft also documents duplicate entities from overlapping discovery. [Discovery documentation][discovery]

This repository enables recommended signals and relationship discovery. It creates a suppressed `discovered-app-topology` entity, but the discovery rule does not specify that entity as its parent. Inspect the resulting graph before assuming discovered entities cannot influence the root. Sources: [discovery rule](../../infra/modules/health-model-discovery.bicep), [relationships](../../infra/modules/health-model-relationships.bicep), [suppressed entity](../../infra/modules/health-model-entities.bicep).

## Evidence needed before deployment

Execute the current KQL against the intended workspace; inspect emitted names, component IDs, timestamps, and per-location counts. Compare the configured signal's value/history with the chosen query window. Establish no-data behavior and permissions using the model identity, then inspect the resulting relationship graph.

The existing [name-consistency test](../../tests/test_app.py#L275-L287) only compares parameter defaults. It cannot establish query validity or deployed behavior. No infrastructure or application code changed during this investigation.

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
