# Storyboard scene guides

Five guides, one per scene of the Azure Monitor Health Models explainer video. Each maps the
storyboard shots to something you can film against a live demo environment.

| Scene | Guide | Duration |
|---|---|---|
| 1 | [scene-1-noise.md](./scene-1-noise.md) | 0:00–0:22 |
| 2 | [scene-2-health-models.md](./scene-2-health-models.md) | 0:22–0:55 |
| 3 | [scene-3-azure-monitor.md](./scene-3-azure-monitor.md) | 0:55–1:30 |
| 4 | [scene-4-context-ai-ops.md](./scene-4-context-ai-ops.md) | 1:30–1:55 |
| 5 | [scene-5-closing.md](./scene-5-closing.md) | 1:55–2:00 |

## Before you film

```bash
azd up
curl -sS -o /dev/null -w '%{http_code}\n' "https://$(azd env get-value SERVICE_WEB_FQDN)/"
```

`azd up` provisions the infrastructure, deploys all three services and prints `200` once the site
answers. It also prints the app URL you will use all day, and `azd env get-value SERVICE_WEB_FQDN`
returns it again at any time:

```
SERVICE_WEB_FQDN  ca-<env>-web.<region>.azurecontainerapps.io
```

Reach the health model from the portal via **Resource groups → the demo group → the health model**.

`azd up` is the only entry point that provisions or changes infrastructure. `infra/main.bicep`
declares the whole stack at subscription scope; the two `scripts/hooks/` scripts run as azd
`preprovision`/`postprovision` hooks and only touch things ARM cannot express (the signed-in
administrator UPN, the client firewall address, and the PostgreSQL role and table mapping).

One script is out-of-band demo tooling. It reads the deployed stack and drives the demo, and never
creates, updates, or deletes infrastructure:

| Script | Purpose |
|---|---|
| `scripts/demo-failure.sh` | Injects and clears the on-camera failure |

It resolves the resource group, health model, container app and database from the selected azd
environment, so `azd env select <name>` is the only thing that points it at a stack.

## Tearing down

```bash
azd down --force --purge
az monitor diagnostic-settings subscription delete --name "diag-$(azd env get-value AZURE_ENV_NAME)-activity" --yes
az role definition delete --name "AHM Demo Health Report Operator ($(azd env get-value AZURE_ENV_NAME))"
```

`azd down` removes the resource group. The activity-log diagnostic setting and the custom role
definition live at subscription scope, outside the resource group, so the two `az` commands finish
the job.

## Synthetic traffic

An Application Insights standard availability test runs every 5 minutes against the app's home page.
It keeps a replica warm so CPU, memory and response-time report real numbers on camera, and it gives
Scene 3 a genuine availability chart. It only issues a plain `GET /`, so it writes nothing.

A second test exercises the full request journey and therefore writes to the queue and database on
every run. That is what makes the storage signals show real values, so enable it while filming
Scenes 2 and 3, from **Application Insights → Availability → the journey test → Enable**.

Disable it again once those scenes are in the can, so the queue and database signals settle back to
their idle baseline before the next take.

## Checking the signals are real

```bash
az monitor health-models entity list \
  --resource-group "$(azd env get-value AZURE_RESOURCE_GROUP)" \
  --health-model-name "$(azd env get-value HEALTH_MODEL_NAME)" \
  --query "[].{entity:name,health:properties.healthState}" --output table
```

Every hand-authored entity should report `Healthy`. A `Unknown` row means a signal has no data yet;
enabling the journey test above usually clears the storage and database ones.

## Icons

The 21 icons the storyboard needs are committed in [`icons/`](./icons/) — see
[icons/README.md](./icons/README.md) for the contact sheet, source and licence.

| Element | | File |
|---|:---:|---|
| Health Models | <img src="./icons/03528-icon-service-Monitor-Health-Models.svg" width="26" alt=""> | [`03528-icon-service-Monitor-Health-Models.svg`](./icons/03528-icon-service-Monitor-Health-Models.svg) |
| Azure Monitor | <img src="./icons/00001-icon-service-Monitor.svg" width="26" alt=""> | [`00001-icon-service-Monitor.svg`](./icons/00001-icon-service-Monitor.svg) |
| Application Insights | <img src="./icons/00012-icon-service-Application-Insights.svg" width="26" alt=""> | [`00012-icon-service-Application-Insights.svg`](./icons/00012-icon-service-Application-Insights.svg) |
| Log Analytics | <img src="./icons/00009-icon-service-Log-Analytics-Workspaces.svg" width="26" alt=""> | [`00009-icon-service-Log-Analytics-Workspaces.svg`](./icons/00009-icon-service-Log-Analytics-Workspaces.svg) |
| Azure Metrics Explorer | <img src="./icons/00020-icon-service-Metrics.svg" width="26" alt=""> | [`00020-icon-service-Metrics.svg`](./icons/00020-icon-service-Metrics.svg) |
| Activity Log | <img src="./icons/00007-icon-service-Activity-Log.svg" width="26" alt=""> | [`00007-icon-service-Activity-Log.svg`](./icons/00007-icon-service-Activity-Log.svg) |
| Service Health | <img src="./icons/10004-icon-service-Service-Health.svg" width="26" alt=""> | [`10004-icon-service-Service-Health.svg`](./icons/10004-icon-service-Service-Health.svg) |
| Alerts | <img src="./icons/00002-icon-service-Alerts.svg" width="26" alt=""> | [`00002-icon-service-Alerts.svg`](./icons/00002-icon-service-Alerts.svg) |
| Server / VM | <img src="./icons/10021-icon-service-Virtual-Machine.svg" width="26" alt=""> | [`10021-icon-service-Virtual-Machine.svg`](./icons/10021-icon-service-Virtual-Machine.svg) |
| Container Apps env | <img src="./icons/02989-icon-service-Container-Apps-Environments.svg" width="26" alt=""> | [`02989-icon-service-Container-Apps-Environments.svg`](./icons/02989-icon-service-Container-Apps-Environments.svg) |
| PostgreSQL | <img src="./icons/10131-icon-service-Azure-Database-PostgreSQL-Server.svg" width="26" alt=""> | [`10131-icon-service-Azure-Database-PostgreSQL-Server.svg`](./icons/10131-icon-service-Azure-Database-PostgreSQL-Server.svg) |
| Storage Queue | <img src="./icons/10840-icon-service-Storage-Queue.svg" width="26" alt=""> | [`10840-icon-service-Storage-Queue.svg`](./icons/10840-icon-service-Storage-Queue.svg) |
| Storage account | <img src="./icons/10086-icon-service-Storage-Accounts.svg" width="26" alt=""> | [`10086-icon-service-Storage-Accounts.svg`](./icons/10086-icon-service-Storage-Accounts.svg) |
| Cosmos DB | <img src="./icons/10121-icon-service-Azure-Cosmos-DB.svg" width="26" alt=""> | [`10121-icon-service-Azure-Cosmos-DB.svg`](./icons/10121-icon-service-Azure-Cosmos-DB.svg) |
| Event Hubs | <img src="./icons/00039-icon-service-Event-Hubs.svg" width="26" alt=""> | [`00039-icon-service-Event-Hubs.svg`](./icons/00039-icon-service-Event-Hubs.svg) |
| Service Bus | <img src="./icons/10836-icon-service-Azure-Service-Bus.svg" width="26" alt=""> | [`10836-icon-service-Azure-Service-Bus.svg`](./icons/10836-icon-service-Azure-Service-Bus.svg) |
| SQL Database | <img src="./icons/10130-icon-service-SQL-Database.svg" width="26" alt=""> | [`10130-icon-service-SQL-Database.svg`](./icons/10130-icon-service-SQL-Database.svg) |
| App Service | <img src="./icons/10035-icon-service-App-Services.svg" width="26" alt=""> | [`10035-icon-service-App-Services.svg`](./icons/10035-icon-service-App-Services.svg) |
| AKS | <img src="./icons/10023-icon-service-Kubernetes-Services.svg" width="26" alt=""> | [`10023-icon-service-Kubernetes-Services.svg`](./icons/10023-icon-service-Kubernetes-Services.svg) |
| Managed Grafana | <img src="./icons/02905-icon-service-Azure-Managed-Grafana.svg" width="26" alt=""> | [`02905-icon-service-Azure-Managed-Grafana.svg`](./icons/02905-icon-service-Azure-Managed-Grafana.svg) |
| Resource Explorer | <img src="./icons/10349-icon-service-Resource-Explorer.svg" width="26" alt=""> | [`10349-icon-service-Resource-Explorer.svg`](./icons/10349-icon-service-Resource-Explorer.svg) |

Three storyboard elements have no dedicated icon. The substitutes mean something else, so always
pair them with a text label:

| Missing | Substitute |
|---|---|
| Resource Health | [`10004-icon-service-Service-Health.svg`](./icons/10004-icon-service-Service-Health.svg) |
| Azure Resource Manager | [`10349-icon-service-Resource-Explorer.svg`](./icons/10349-icon-service-Resource-Explorer.svg) |
| Azure Monitor workspace | [`00001-icon-service-Monitor.svg`](./icons/00001-icon-service-Monitor.svg) |

### Licence

*"Microsoft permits the use of these icons in architectural diagrams, training materials, or
documentation. You can copy, distribute, and display the icons only for the permitted use unless
granted explicit permission by Microsoft."* Don't crop, flip, rotate or distort them.

**A promotional cut is not on that list.** If this video is marketing rather than training or
documentation, get written permission before distribution.

---

These guides deliberately carry no subscription, tenant, or account identifiers. Everything is
either a script invocation or a portal navigation path.
