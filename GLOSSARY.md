# Azure Health Model demo

A web application, API, and AI agents for viewing and changing Azure health models.

## Language

### Work with agents

**Task**:
A unit of agent work the user starts on a health model, ending in a structured result rather than a chat reply.
_Avoid_: Prompt, chat, conversation

**Review task**:
A **Task** that inspects an existing health model and returns findings and a **Health model diff**.

**Explain task**:
A **Task** that traces why an entity shows its current health state, back to signals, thresholds and rollup.

**Design task**:
A **Task** that derives a new health model for a workload and returns it as a **Health model diff** against an empty model.

**Task instruction**:
Optional free text the user adds to a **Task** to steer it, such as "fix what the previous task found".
_Avoid_: Prompt, message

**Workload**:
The resource group, and optionally a public Git repository, that a **Design task** derives a health model from.

**Health model diff**:
The proposed additions, changes and removals of entities, signals and relationships against a **Base model**.
_Avoid_: Patch, changeset

**Base model**:
The snapshot of a live health model that a **Health model diff** was computed against.

**Proposed model**:
The **Base model** with its **Health model diff** applied, shown beside it for comparison.

**Verification**:
Running each new or changed signal in a **Health model diff** against real data and marking it verified or failing. A failing signal does not block **Apply**.
_Avoid_: Validation, test

**Activity timeline**:
The recorded steps a **Task**'s agents take (agent, tool call, query, sandbox run, file), shown live and kept with the **Task**.
_Avoid_: Log, trace, transcript

**Apply**:
Writing an approved **Health model diff** to a live health model in this deployment's resource group.
_Avoid_: Deploy, publish

**Session**:
A shared workspace holding an ordered list of **Tasks**, their results and their files. It has no owner.
_Avoid_: Thread, conversation, chat

## Relationships

- A **Session** holds many **Tasks**; a **Task** can build on the results of earlier **Tasks** in its **Session**.
- A **Review task** and a **Design task** each produce one **Health model diff**.
- An **Explain task** produces no **Health model diff**.
- A **Health model diff** gets one **Verification** before the user approves it.
- The user approves some or all changes of a **Health model diff**; an entity's signals and relationships are approved with it. Only approved changes are **Applied**.
- An **Apply** cannot be undone from the app.
- A **Session** is never deleted.
