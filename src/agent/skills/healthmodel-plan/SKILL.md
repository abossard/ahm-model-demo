---
name: healthmodel-plan
description: "Plan an Azure Monitor health model for a workload: explain health modeling concepts, derive user flows, system flows, entities, signals and alerts from the project's code, infrastructure and docs, plan one complete model that covers every user flow end to end with sensible defaults, and write a reasoned modelspec.md plus a visual, user-facing plan.md. Use whenever the user wants to design, plan, scope, review or update a health model, asks what health means for their app, or asks how health modeling, entities, signals, rollup or health objectives work, even if they don't say 'plan'."
---

# Health model plan

## First check there is something to plan from
- look at the conversation and the working directory before anything else
- if the user wants a plan but there's no information about the workload at all (no code, no docs, nothing in the conversation), skip the reading below and go straight to [When to ask the user](#when-to-ask-the-user)
- a question about concepts only needs no workload, answer it as described in [Terminology](#terminology)

## Health theory foundation
- read this to learn about health modelling https://learn.microsoft.com/en-us/azure/well-architected/design-guides/health-modeling
- read the concepts of Azure health models from here https://learn.microsoft.com/en-us/azure/azure-monitor/health-models/concepts

## Goal of this skill
Explain health modelling concepts and help the user build a health model plan or update an existing health model or plan.

The plan aims at one complete, fully working health model with little user intervention: every user flow is covered end to end, the agent chooses sensible defaults where sources are silent, and the user is only asked for information that can't be found or reasonably assumed.

## Agent guidelines
- ideally the majority of the work is done by the agent
- ideally the skill is invoked in a project or environment with files or other information available about a workload or application
- if it's not possible to write files, the agent should find other ways to keep track and inform the users and provide a final plan
- use research and subagents and use native plan and todo tools where available

## Desired input

To create a plan and modelspec, the skill requires at least one of the following inputs from the user:

- Architecture overview, high level system diagrams
- Operational concerns, such as reliability, performance, and availability requirements.
- User commitments and expectations for service levels.
- Any existing health model context or documentation.
- Observed issues, incidents, or gaps in telemetry that may affect health assessment.
- User and system flows, the health objective for each flow, their dependencies, and shared source material.
- Where the user wants alerts placed, relevant existing alert-rule references/inventory, and any notification-routing choices.

If you can't find any of the information or there's a lack of information, report it as gap in the modelspec with either `user input` or `research/lookup`.

## Terminology

Answer concept questions from the context the user already provided. Use plain, concrete language. Do not require an interview, modelspec, or another skill invocation for a concept-only answer.

These are the important health modelling terms that we want to introduce to the user:

- **Entities** represent user flows, system flows, Azure resources or any other component required to build the health model. Alerts are on the entities, but also you can configure the health rollup. Entities have their own health state and health history and external health reports are sent to entities. Deleting an entity also makes you lose its history. Each health model comes with a root entity that has the same name as the health model.
- **Signals** provide health evidence. They can be based on Log Analytics Queries, Azure Monitor metrics or Azure Monitor Workspace PromQL queries. If a signal is deleted, you'll lose its health history. There are also signal aggregation groups, that allow multiple signals to have a custom rollup.
- **Relationships** propagate dependency into entity health. At the top level, the entities should have a relationship to the health model root entity.
- **Signal Definition** signals can be saved as reusable definitions, which is the recommended way to manage them.
- **Health objectives** how much percentage of time an entity is expected to be healthy.
- **Health States** define the condition of an entity based on its signals and relationships.
  - **Healthy** means working as expected.
  - **Degraded** means diminished function or performance.
  - **Unhealthy** means not working or unacceptable performance.
  - **Unknown** means insufficient evidence/signals.

### Subject of health
- Health means that the expected value is being produced
- Health can be of an azure resource, e.g. VM, but health modelling is ultimately about aggregating a lot of lower level health signals and roll them up into what is meaningful for the user or business
- Health models can be nested, to allow others to directly consume aggregated health.

## How to build a health model with this skill
- before you start, read [the modelspec template](templates/modelspec.md) and the [plan template](templates/plan.md)
- the COMMENTS are important for YOU as the AI.
- create a copy of the modelspec template and this will be the working document for the remainder of the planning
- in the end create a plan.md that summarizes the health model and the decisions made and is easy to understand
- write only these two files, to `docs/healthmodel/` unless the user or the project already has another place; don't edit other files, create branches or commit, the user reviews the plan first
- plan.md is for people who don't know health models well yet: plain names instead of IDs, short sentences, failure scenarios only with names from its own diagram, and the assumptions as a short list; keep the template's sections, table columns, signal nodes and color legend. Only the Azure resource boxes keep their technical names
- before finishing, reread plan.md as that reader: replace every term they wouldn't know with what it means (the plan template has examples), and move caveats, disclaimers and evidence limits to the modelspec; plan.md says what the model will show, in about two screens
- if you talk to the user, keep your answers short, concise and informative
- don't repeat details that are in the modelspec as well
- if the modelspec becomes too large, it's fine to split it into multiple files
- use awk or other tools to manage the content in the modelspec if it's more efficient
- adhere to the output shape and keep it as shared progress/source contract
- create or refine the modelspec and entity plan from conversation context or any user-provided file
- the user can also point to an existing modelspec or ask for a different way to keep track
- treat the modelspec as "code", so don't add prose, but provable, reliable information in a clear structure

### Capture context and sources
- at the top most of the modelspec are the user flows, which is what other people, stakeholders, see and expect from the health model subject
- give stable identities to the collected data and sources and reference them in decisions. It should be transparent where information comes from and on what decisions are based on

### Draw the high-level model
- in the end, the goal is something that is helpful and the user can relate to
- to make sure the user can agree on what is being built, it's helpful to visualize it and make sure it's understood
- in the modelspec there's a mermaid diagram as example, but if there's another established pattern the user prefers, that's fine too

### Derive entities and resolve gaps
- when you come up with entities, record its identity and why it needs to exist in short terms and references, so it's easy to update when a source changes
- don't invent facts (flows, resources, commitments), record gaps and lack of information, and help the user to follow up on it
- classify each gap as `research/lookup` for discoverable facts, `user input` for when a user input is required, or `assumption` for a default you chose that the user can change later

### Cover every user flow
- keep the model small enough to read at a glance: group similar user flows into one larger flow (e.g. "search products" and "browse categories" become "find products"), and put signals that belong together on the same entity instead of one entity per signal
- a separate entity has to earn its place: its own meaning for the user, its own owner, alert or health objective, or a different impact (e.g. an optional dependency)
- never drop a flow because it has no telemetry of its own (e.g. a batch or ingestion job): model it with the platform metrics of the resources it uses, and record the missing flow-level signal as a gap
- model what is deployed, or what is on by default when nothing is deployed (check the IaC parameters, deployment settings and, if you can read it, the deployed resources); list optional features that are off as "not modelled" in plan.md, so the user can ask to add them
- build three layers, each rolling up into the one above:
  1. **user flows**: what users do (e.g. "Browse products", "Complete a purchase"); virtual entities, usually without signals
  2. **system components** (also called system flows): one level of functional parts that make the user flows work, named by what they do, not by the Azure service (e.g. "Storefront API", "Product catalog", "Search service", "Payment gateway"); virtual entities under the user flow they serve
  3. **Azure resources**: directly under each component, entities bound to the concrete resource (e.g. "Search service" over the Azure AI Search instance), with its platform metrics. Give them a technical name that identifies the resource, and the sub-resource where it matters, and is unique in the whole model (e.g. `AI Search: products-index`, `Azure SQL: orders`, or a resource name with its location when two look alike); never repeat the component's name. If a name is only known after deployment, the build fills it in
- build a tree, not a network: every entity has a single parent. When two flows use the same component or resource, give each flow its own entity for it, with the signals that matter for that flow (e.g. "Storefront API" under Browse with failed catalog requests, and under Checkout with failed checkout requests). Each flow's rollup stays readable, and each copy can have its own thresholds
- a system component is not a renamed user flow: if every user flow has exactly one system component under it, you have restated the flows; a flow usually needs several components
- avoid entities with a single child, they add a level without meaning: merge a virtual entity into its only virtual child (no "Knowledge index" over just "Search service"). The one exception is a component over its single Azure resource, because that boundary keeps the component's history when the resource is replaced
- prefer abstraction: flows and components describe function and stay valid when the technology changes; only the resource entities carry concrete Azure resource names and types
- flows and components live as long as the workload, while Azure resources come and go: a resource can be replaced underneath a stable component, and the flows and components keep their health history (deleting an entity deletes its history)
- measure what users experience (failed requests, latency, throttling) on the system component that serves it, as a query on the Log Analytics or Azure Monitor workspace that holds the telemetry; platform metrics sit on the Azure resource entities
- for each user flow, trace the system components and resources it depends on; every leaf entity needs at least one signal, otherwise it shows Unknown, and never copy a child's signal onto a parent
- use the features that make the model useful: health objectives and alerts on user flows, limited impact for optional dependencies (required ones keep standard impact), signal definitions for repeated signals, nested models for separately owned platforms
- walk through 2-4 failure scenarios ("if the database is down, Order processing turns Unhealthy, Complete a purchase turns Unhealthy, the purchase alert fires") to check the rollup gives the right state, and show them in plan.md; list every entity whose state changes, including other flows that use the same resource and the root
- before finishing, check coverage: no user flow without signals underneath it, no leaf entity without signals, every resource in the diagram backs a component, components aren't one-to-one copies of the flows, no virtual entity has a single virtual child, and every entity has exactly one parent

### Define signals
- look up what exists instead of guessing: [supported metrics per resource type](https://learn.microsoft.com/azure/azure-monitor/reference/supported-metrics/metrics-index), [Application Insights telemetry and tables](https://learn.microsoft.com/azure/azure-monitor/app/data-model-complete), [signal types](https://learn.microsoft.com/azure/azure-monitor/health-models/signals)
- for every entity that needs evidence, record the signals in the modelspec signals table: kind and source, metric or query, aggregation and window, degraded and unhealthy rule
- start simple: a count of failed requests on each component that serves a flow is a good first signal, healthy when nothing fails, also without traffic; add latency, ratios or percentiles only where the user cares about them
- a metric filtered to a value that never occurs in a healthy app (a 5xx or 429 dimension) has no data and stays Unknown; count those failures in a query that returns 0, or use the unfiltered metric. The same goes for metrics that only report under traffic: pair them with a signal that has data when it's quiet
- build signals on data that exists today, so the model works on day one: Azure Monitor platform metrics of the resources (e.g. request count and response time of a web app, availability of a managed service, database CPU) and the Application Insights tables the app already writes (e.g. AppRequests filtered by the flow's route, AppDependencies, AppExceptions); check the code and IaC for what is really sent and which table it lands in (e.g. logged exceptions go to AppExceptions, not AppTraces)
- a signal that needs new instrumentation (custom events, synthetic tests) is a `user input` gap that names the code change; it can be added on top, but never be the only signal of an entity, it would show Unknown until the code changes
- numbers the user gives (targets, latency limits, error rates) are sources: cite the user's message as an S-ID and use them as given, they are never an `assumption`. This includes numbers in a complaint: "checkout sometimes takes 10s+" means 10s is where the flow becomes unhealthy
- a query returns the measured value (failure rate, latency, count), never a state code; thresholds belong in the signal's degraded and unhealthy rules, so they can be tuned per entity
- the build skill verifies every signal against live data before deploying, so make each one precise enough to run

### When to ask the user
- ask only for what you can't find or reasonably assume, typically which user flows matter when code and docs don't show them
- if there's no information about the workload at all (no code, no docs, nothing in the conversation), don't plan and write no files; reply with exactly this, nothing before or after it:

  > I need three things before I can plan a health model:
  > 1. What does the app do? a) sells products or services online b) manages data or records c) something else
  > 2. Who uses it? a) customers b) employees c) other systems
  > 3. What do they do with it? a) buy or book something b) look up or change information c) something else
  >
  > Or point me to the code or architecture docs.
- choose sensible defaults for everything else (thresholds, windows, impact, alert severity; e.g. the service's documented limits or common starting values) and record them as `assumption` with their reason
- ask in one round, with a proposed answer for each question
- if you can't ask (e.g. a non-interactive run) but there is something to plan from, continue with assumptions and list the open questions at the end

### Place alerts and find existing rules
- based on the users concerns and input, which can also contain diagnostic data, existing valuable or not valuable alerts, place them into the model and think how they could be surfaced through the model
- to find out whether a suitable alert rule already exists, read alert rules only in the agreed scope and return full rule IDs with target, condition and enabled state; several matches go to the user to pick, and an incomplete read is a `research/lookup` gap, not proof that no rule exists

## Follow through
- use visualization, canvas or other tools to engage the user and encourage that they understand what is being built
- when the plan is accepted, point the user to `healthmodel-build` to verify the signals and deploy the model
