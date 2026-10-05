# Demo guide

## Explore a model

Select a model, open a node, and inspect its health, signals, dependencies, and history.
The application model is the default. The selector lists models the app's Azure identity can read.

Use the shop model for a small, repeatable diagram. It has 18 entities and 21 relationships:
Shopping, Checkout, and Orders connect to six services, Stripe and PayPal simulations, and six Azure
resources. It creates no shop workloads or payment integrations.

## Understand the health signals

The application model reads real telemetry. Each shop leaf uses a Log Analytics query that returns
100, so successful evaluations stay Healthy. Query or access failures can produce Unknown.

Health reports add temporary signals to the selected entity. They can affect the model's health
without changing the monitored Azure resource.

## Run the request journey

The application's request-journey action enqueues first, then writes PostgreSQL, then peeks the
oldest visible queue message.

The database is Azure Database for PostgreSQL Flexible Server. It is separate from the Container App
that runs the web application.

The journey always targets the configured application workload, even when another model is selected
in the graph.

If a journey request fails, treat the error as partial by default. The queue enqueue and/or database
insert might have completed before the failure response.

Use the deployed app: the queue's private endpoint is not reachable from a typical local setup.

## Keep a Designer layout

After Arrange or manual positioning, save in Azure Designer and copy the exported coordinates into
Bicep. Otherwise, a later deployment can restore older positions.
See [layout round-trip](../infra/README.md#designer-layout-round-trip).
