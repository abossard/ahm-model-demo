# Scene 2 — Introducing Health Models (the turning point)

**0:22–0:55.** Seven shots. A real dependency graph that starts green, a real database failure, real
propagation, one real alert, and a real recovery.

## Before you roll

```bash
az monitor health-models entity list \
  --resource-group "$(azd env get-value AZURE_RESOURCE_GROUP)" \
  --health-model-name "$(azd env get-value HEALTH_MODEL_NAME)" \
  --query "[].{entity:name,health:properties.healthState}" --output table
```

Enable the journey availability test (see [README.md](./README.md)) at least 20 minutes before this
scene, so the queue and database nodes show live numbers rather than `Unknown`.

Shots 3 to 7 are one continuous `demo-failure.sh` run of 15–25 minutes, most of it stability waits.
Budget a full run per take.

## Shot 1 — Transformation moment

*The ocean flips upside down and resolves into a structured topology graph.*

1. Frame either the portal's **Health topology** blade or the demo app, which is designed for
   filming and reads more cleanly on camera. Both use the same layout coordinates.

## Shot 2 — System state, everything green

*Azure resources form a connected dependency graph. Everything starts green and stable.*

1. Confirm green on screen before rolling.
2. The storyboard names AKS, Cosmos DB, Event Hub, SQL DB, Service Bus, App Services and VMs. This
   demo has a container app, a database and a queue. Either film the real three and let the
   voiceover carry the generality, or animate the fuller set with the Scene 2 filler icons in
   [README.md](./README.md). Don't mix — a graph showing Cosmos DB that then fails on PostgreSQL
   will not cut together.

## Shot 3 — First signal of failure

*One database node turns red.*

1. Start the scripted outage:

   ```bash
   bash scripts/demo-failure.sh
   ```
2. It stops the database for real, so the red is genuine. The database node goes red first, while
   everything above it is still green for a few seconds. That gap is shot 4.

## Shot 4 — Propagation

*Health propagates through dependencies, green → amber → red, top-level app goes red.*

1. Keep rolling through the same run. Failure climbs from the database up to the application root.
2. The platform-context node stays green throughout, by design. Leave it in frame — it shows the
   model separating application failure from platform noise, which sets up Scene 4 shot 2.

## Shot 5 — Single source of truth

*Only one alert is generated.*

1. True by construction: only the root entity carries an alert. No child entity has one.
2. Use <img src="./icons/00002-icon-service-Alerts.svg" width="20" alt=""> [`Alerts`](./icons/00002-icon-service-Alerts.svg) for the alert mark.
3. The contrast to sell: six entities unhealthy, one alert.

## Shot 6 — Root cause insight

*A magnifying glass traces from application-level impact down to the failing node.*

1. Click the root entity, then follow the highlighted unhealthy edges down to the database.
2. In the demo app, selecting a node highlights its connectors, which reads better on camera than
   the portal's density.
3. The storyboard says Cosmos DB; the failing node here is PostgreSQL. Change the storyboard text or
   accept the substitution — don't caption a PostgreSQL node as Cosmos DB.

## Shot 7 — Operational response

*An operator triggers failover, traffic reroutes, the system stabilises, health returns to green.*

1. The script continues on its own: it annotates the remediation, restarts the database, and then
   waits to confirm the recovery held rather than flickered.
2. Green returns bottom-up, mirroring shot 4. Film the whole return.
3. The script restores the database on every exit path, including Ctrl-C, so cutting early still
   leaves the environment healthy.
