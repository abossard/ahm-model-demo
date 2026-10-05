# Infrastructure

`main.bicep` provisions the whole demo at subscription scope: the resource group, the workload, and
three Azure Health Models.

## The health models

| Model | Module | What it describes |
|-------|--------|-------------------|
| `hm-<env>` | `modules/health-model.bicep` + `health-model-entities.bicep` + `health-model-relationships.bicep` + `health-model-discovery.bicep` | The real application: 19 authored entities over live metrics, log queries, availability tests, submitted health reports, and an Application Insights discovery rule. This is the model the web app selects by default. |
| `hm-<env>-shop` | `modules/shop-health-model.bicep` | A fictional shop with 18 entities, 21 relationships, and no discovery. |
| `hm-<env>-survey` | `modules/survey-health-model.bicep` | Survey authoring, joining/answering, and public results over real resources; no discovery or constant-healthy signals. |

All live in the same resource group, and `azd provision` creates them together.

## Survey ownership

The survey adds its own `survey` Container App and survey health model. It reuses the unchanged
`container-app.bicep`, existing environment, ACR, user-assigned workload identity, PostgreSQL
`demo` database, Application Insights, and workspace. No additional AI, database server, standalone
identity, telemetry component, availability-test resource, or survey AKS service is provisioned.
The new Container App and model evaluations can incur cost. Template changes are not deployment
permission; inspect current images, layouts and grants before an authorized provision.

The azd image input is `SERVICE_SURVEY_IMAGE_NAME`. Outputs provide `SERVICE_SURVEY_NAME`,
`SERVICE_SURVEY_ID`, `SERVICE_SURVEY_FQDN`, `SURVEY_HEALTH_MODEL_NAME` and
`SURVEY_HEALTH_MODEL_ID`. URLs and resource leaves derive from these outputs.

The existing postprovision hook applies `src/survey/migrations/001_initial.sql` as the PostgreSQL
administrator. Its transaction and advisory lock record version 1 in `survey.schema_migrations`;
repeat/concurrent runs are safe and failure rolls back. Runtime requests never execute DDL.
For survey-only administrator maintenance, `scripts/hooks/postprovision.sh --survey-only` uses
the operator's `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, TLS/credential environment, and
`AZURE_IDENTITY_NAME`. It never runs the old demo bootstrap or Azure CLI. It adds schema USAGE,
table DML, and migration-version SELECT without changing old data or grants. Future migrations
need new numbered versions; do not edit an already-applied migration to upgrade a deployment.

The reused identity retains old Queue and `public.request_events` permissions. Schema-qualified,
bound survey SQL confines application effects; this is not privilege isolation. There is no queue
or health-report client in the survey process.

Survey telemetry uses the stable role `ahm-survey` and allowlisted operation/status/duration
metadata only. HTTP/SQL/credential auto-instrumentation and access logging are disabled. No bodies,
answers, capabilities, query strings, client IPs, or SQL parameters are exported. Four legacy
workspace log queries exclude `AppRoleName == "ahm-survey"` while retaining all other or missing
roles. Classic Application Insights equivalents use `cloud_RoleName`; old producers are not retagged.
Shared physical-resource metrics and outages are still shared. Existing resource-level Insights
discovery cannot be partitioned by a role filter and remains an unverified, deferred limitation.

Survey logical nodes roll up `WorstOf` with `ignoreUnknown: false`. Operation success queries
require recent samples; empty/stale traffic yields no healthy row. The model's system identity
receives the existing access-module read grants before resource-bound entities are created.
Five signal-only operation-evidence leaves carry the author, join, ballot, results and readiness
queries. Their system flows depend on those leaves as well as the real resources. Keeping the
operation query separate prevents resource health from masking its Unknown input inside the
same entity. It does not by itself prove that the native dependency aggregator propagates
Unknown to a mixed Healthy/Unknown parent. The survey graph has 18 entities and 25 relationships; no extra Azure platform
resource or permission is required. Verify native propagation rather than inferring root health
from the query result or compiled settings.
The model/authentication, access grants, and `survey-health-entities.bicep` child deployment are
separate ARM validation boundaries. CloudHealth validates signal-bearing children only after
the new model and its read grants exist. Native provider validation is still required: a successful
Bicep compilation does not validate signal names or KQL functions.
`GET /api/ready` checks `SELECT 1` and migration version without writes. No continuous write probe
or automatic survey discovery is added. Actual evaluator timestamps and Azure ingestion still
require authorized deployed read-back. Use Designer initially; existing catalog permissions do
not guarantee survey visibility, and no subscription permission is broadened.

### Scoped survey deployment

For an existing environment, use the resource-group-scoped
`modules/survey-deployment.bicep`, not a full-stack provision. It takes the existing environment,
identity, registry, PostgreSQL, Insights and workspace names as parameters and derives IDs and
settings from those existing resources. It adds only the survey Container App, health model,
children and model read grants. Pass a previously built and locally verified linux/amd64 image
by immutable registry digest. Run property-level `az deployment group what-if` against the
intended subscription and resource group before `az deployment group create`.

Snapshot current app images/revisions, authored model properties, grants and demo data first.
If live legacy queries or layouts differ from source, update only the four approved operational
query clauses in their actual live entity. Do not redeploy the old entity from the source template
or reconcile missing models. Apply the administrator's survey-only migration, never the old demo
bootstrap. Keep authentication tokens and telemetry settings out of command output and files.

The readiness endpoint is GET-only. A deployed smoke survey is a separate authorized data write;
use one dedicated survey, keep capabilities only in process/browser memory, and clear its answers
through its response API afterward. Do not delete it with SQL or exercise old report/journey
mutation endpoints. Verify the actual active digest/revision, public flows, telemetry role and
native evaluator timestamps. Initial model read grants can need an evaluation interval to
propagate; Unknown or a query error is not proof of Healthy.

## The shop model

A compact standard shop: 18 entities and 21 directed relationships, tuned so the Designer's layout
mechanism has room to work. The root `Contoso Shop` has three flows, each fanning out to services.

- Shopping covers browsing: Product Catalog and Shopping Cart.
- Checkout covers paying: Shopping Cart and Payments.
- Orders covers fulfilment: Order Processing, Inventory, and Analytics.
- Payments routes to Stripe and PayPal. Both are external-provider simulations that carry the
  synthetic signal and bind no Azure resource, because the demo integrates no real provider.

The saved Designer layout places the flows above the services, with Azure resources and simulated
providers below.

The six Azure-resource nodes bind existing resources through module outputs:

| Entity | Bound resource |
|--------|----------------|
| `azure-postgres` | PostgreSQL flexible server (`Microsoft.DBforPostgreSQL/flexibleServers`), catalog and inventory persistence |
| `azure-aks` | AKS cluster (`Microsoft.ContainerService/managedClusters`), cart and payment services |
| `azure-web` | Web container app (`Microsoft.App/containerApps`), catalog and order-processing front end |
| `azure-queue` | Queue service (`Microsoft.Storage/storageAccounts/queueServices`), named `default` under that account |
| `azure-storage` | Storage account (`Microsoft.Storage/storageAccounts`), shared cart storage |
| `azure-workspace` | Log Analytics workspace (`Microsoft.OperationalInsights/workspaces`), analytics backing |

The module displays each resource's actual name and type. The business responsibilities are fictional:
deploying this model does not deploy commerce workloads or payment integrations.

### Synthetic demo health

All eight leaves (six Azure resources and two providers) carry one Log Analytics signal,
`Synthetic demo health (constant 100)`. It runs `print Value = 100`, reads the `Value` column,
and becomes unhealthy only for `GreaterThan` 100. Query and refresh intervals are both `PT5M`.
Successful evaluations stay Healthy without workload traffic or expiring health reports.

The signal cannot evaluate Unhealthy while the query succeeds, but it can go Unknown: the model's
identity losing its workspace read grants, the workspace becoming unavailable, or the evaluator not
running all produce Unknown rather than Unhealthy. All 10 logical nodes aggregate `WorstOf` with
`ignoreUnknown: false`, so an Unknown leaf affects the root.

**This signal says nothing about the bound resource's real condition.** The resource binding exists
so the entity points at a real resource; Azure Resource Health is explicitly `Disabled` on it and no
resource metrics are attached. Read `hm-<env>` for the application's real health.

The model authenticates with a system-assigned identity and is granted Reader and Monitoring Reader
on the resource group through `modules/health-model-access.bicep`, the same module the application
model uses. Signal-bearing entities consume that module's outputs, ordering resource bindings and
queries after the read grants.

## Deploying

For a first deployment, follow [Get started from scratch](../README.md#get-started-from-scratch).
Use `azd up` to provision resources and deploy application images.

For infrastructure changes in a configured environment, `azd provision` provisions all models but
does not deploy application images:

```bash
azd provision
```

The shop model alone, against an existing group, without touching anything else:

```bash
az deployment group create \
  --subscription <sub> --resource-group rg-<env> \
  --name shop-health-model --mode Incremental \
  --template-file infra/modules/shop-health-model.bicep \
  --parameters modelName=hm-<env>-shop healthModelLocation=northeurope \
               containerAppId=<id> aksClusterId=<id> postgresId=<id> \
               storageId=<id> workspaceId=<id> \
               tags='{"azd-env-name":"<env>","workload":"azure-health-model-demo"}'
```

Pass the same tags `main.bicep` builds, or the model loses them on the next run. Read the five resource
IDs from the deployment that produced them rather than typing them:

```bash
az deployment group show --subscription <sub> -g rg-<env> -n container-app-web --query properties.outputs.containerAppId.value -o tsv
az deployment group show --subscription <sub> -g rg-<env> -n aks --query properties.outputs.clusterId.value -o tsv
az deployment group show --subscription <sub> -g rg-<env> -n foundation --query properties.outputs.postgresId.value -o tsv
az deployment group show --subscription <sub> -g rg-<env> -n foundation --query properties.outputs.workspaceId.value -o tsv
az deployment group show --subscription <sub> -g rg-<env> -n storage --query properties.outputs.storageId.value -o tsv
```

Preview with `az deployment group what-if` using the same template and parameters. Inspect the
property-level diff. Only the shop, its children, its identity's read grants, and nested deployment
records may change. Do not run a full-stack provision against an existing environment to update
this model: it may overwrite portal edits or redeploy an older saved app image.

What-if can report `Modify` for read-only `properties.healthState`, generated
`resourceHealth.signalName`, and signal `status`. Distinguish these from authored changes such as
coordinates, bindings, or query rules. Compare full authored configuration before and after deployment.

The two role assignments can appear as `Unsupported`, because their names come from
`guid(..., modelPrincipalId, ...)` and what-if cannot resolve a principal the model has not created yet.
For an existing shop, resolve them against its live principal and compare scope, role, and identity.

### Model catalog access

A fresh deployment grants the app access to its own application model. The provisioning hook prints
`CATALOG_SCOPE single-model` and the missing role-assignment commands if subscription-wide access is
absent.

To browse and submit reports across models, review those printed commands before running them:
`Reader` permits model browsing; the custom `AHM Demo Health Report Operator` role permits reports.
Both printed grants cover the subscription, including models outside this project. Use them only in
a subscription where you intend to give the app that access.

If you leave these grants unset, the app continues with its application model as the fallback.

### Reducing an existing shop

Incremental deployment does not remove entities or relationships omitted from Bicep. Before deploying
a smaller graph, list the target shop's current relationships and entities and follow pagination:
relationship pages hold 50, so reading only the first page produces a false deletion set.

Build the deletion set as exact full IDs, compare it against the live lists case-insensitively, and
stop if anything differs from the plan. Delete relationships before entities, because an entity that
still has an edge cannot be removed:

```bash
az rest --subscription <sub> --method delete \
  --url "https://management.azure.com<shop-model-id>/relationships/<name>?api-version=2026-05-01-preview"
az rest --subscription <sub> --method delete \
  --url "https://management.azure.com<shop-model-id>/entities/<name>?api-version=2026-05-01-preview"
```

Delete only shop child definitions. The bound Azure resources, their data, and everything in
`hm-<env>` stay untouched.

Then run the shop-only incremental deployment above. Repeating it needs no deletions: require the same
18 names and 21 named endpoint pairs, the same shop principal, and unchanged application-model
configuration, app images, grants outside the shop, and default selection.

### Designer layout round-trip

Before changing an existing shop, capture its entities and export that model alone as Bicep:

```bash
az group export --subscription <sub> --name rg-<env> \
  --resource-ids <shop-model-id> --export-format bicep --include-parameter-default-value
```

Decode the returned JSON string to preserve the Bicep bytes. Keep the original export. Seed retained
entities from its coordinates, rather than an older template. If a layout needs Arrange, open only the
shop Designer, capture before/after positions, arrange, and save. Export again under a new filename
and copy all final `canvasPosition` values into this
module. Preserve fractional coordinates with `json('number')`.

Compile the export and module; compare numeric positions by entity name without rounding. Repeat
the scoped deployment and compare live ARM coordinates again.

Coordinates prove placement, not readability. A rendered graph in the web app confirms the topology,
not that the Designer's automatic layout looks good; that remains a manual visual check.

## Verifying

Use API version `2026-05-01-preview` and follow `nextLink`.

```bash
BASE="https://management.azure.com/subscriptions/<sub>/resourceGroups/rg-<env>/providers/Microsoft.CloudHealth/healthmodels"

az rest --subscription <sub> --method get --url "$BASE?api-version=2026-05-01-preview" # three models
az rest --subscription <sub> --method get --url "$BASE/hm-<env>-shop/entities?api-version=2026-05-01-preview" # 18 entities
az rest --subscription <sub> --method get --url "$BASE/hm-<env>-shop/relationships?api-version=2026-05-01-preview" # 21 edges
```

An entity's `properties.healthState` is `Unknown` until its first evaluation, which lands a few
minutes after deployment. Once it evaluates, every synthetic signal under
`properties.signalGroups.azureLogAnalytics.signals[].status` reports `value: 100`,
`healthState: Healthy`, a fresh `reportedAt`, and no `error`.
Require all 18 entities Healthy and all eight evaluated signals at 100. Take two samples at least five
minutes apart, after the final deployment. Each signal timestamp must advance and be no more than
ten minutes old. Missing data is not a successful health check.

The web app lists every model it can read; pick the shop from its model selector, or request
`/api/health-model?model=hm-<env>-shop&resourceGroup=rg-<env>`.
