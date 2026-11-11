# Azure Health Model demo

A web application, API, and AI agent for viewing and changing Azure health models.

## Language

Two languages, one meaning. In code, the API and the docs we say the domain terms below. In the interface we ask the
user's question: "Why is this Unhealthy?" on screen, **Explain task** in code. Each term lists its **In the UI** label.
The names Azure gives stay the same in both: entity, signal, health model, Healthy, Degraded, Unhealthy, Unknown,
Limited and Suppressed impact, and **Apply**, because the user meets the same words in the portal. The words to avoid
(_Avoid in code_) are about code, tests and docs; the plain words on screen are the point.

A label in the UI is a question or a goal when the user has one ("Why is this Healthy?", "Check this model"), a plain
noun when they only read it ("Proposed changes", "What the assistant did"), and the code and reference of an error
only on a small last line of its message. The labels live in `src/web/ui/src/model/wording.ts`.

### Work with agents

**Assistant**:
The hosted agent that does the work of a **Task**. The user never sees "agent" in the interface.
_In the UI_: "the assistant".

**Task**:
A unit of agent work the user starts on a health model, ending in a structured result rather than a chat reply.
_Avoid in code_: Prompt, chat, conversation
_In the UI_: a question. The list of them in a **Session** is "Questions"; a running one is "Working", a finished one "Done".

**Review task**:
A **Task** that inspects an existing health model and returns findings and a **Health model diff**.
_In the UI_: "Check this model" (button and menu), "Model check" in a sentence, and "Check <model>" as its title.

**Explain task**:
A **Task** that traces why an entity shows its current health state, back to signals, thresholds and rollup.
_In the UI_: the question in the state the entity has: "Why is this Healthy?", "Why is this Degraded?", "Why is this Unhealthy?", "Why is the state unknown?". Its answer is "Answer"; its chain is "What is behind it".

**Design task**:
A **Task** that derives a new health model for a workload and returns it as a **Health model diff** against an empty model.
_In the UI_: "Design a model for my workload", "Design a model" on its form, and "Design for <resource group or repository>" as its title.

**Task instruction**:
Optional free text the user adds to a **Task** to steer it, such as "fix what the previous task found".
_Avoid in code_: Prompt, message
_In the UI_: "Note for the assistant (optional)"; "Add a note" opens it.

**Workload**:
The resource group, and optionally a public Git repository, that a **Design task** derives a health model from.
_In the UI_: "Resource group of your workload" and "GitHub repository (optional)".

**Health model diff**:
The proposed additions, changes and removals of entities, signals and relationships against a **Base model**.
_Avoid in code_: Patch, changeset
_In the UI_: "Proposed changes".

**Base model**:
The snapshot of a live health model that a **Health model diff** was computed against.
_In the UI_: "Model now" (the left side of a comparison).

**Proposed model**:
The **Base model** with its **Health model diff** applied, shown beside it for comparison.
_In the UI_: "Model after the changes" (the right side).

**Verification**:
Running each new or changed signal in a **Health model diff** against real data and marking it verified or failing. A failing signal does not block **Apply**.
_Avoid in code_: Validation, test
_In the UI_: "Signal test"; the marks are "passed", "failed" and "not run".

**Activity timeline**:
The recorded steps the agent takes on a **Task** (tool call, query, sandbox run, file), shown live and kept with the **Task**.
_Avoid in code_: Log, trace, transcript
_In the UI_: "What the assistant is doing" while it works and "What the assistant did" after. Each step is a plain sentence ("Read the health model hm-demo"); the tool name and its arguments are under "Technical details".

**Apply**:
Writing an approved **Health model diff** to a live health model, as the signed-in user.
_Avoid in code_: Deploy, publish
_In the UI_: "Apply" stays. Its confirmation says what happens: "Change the live model hm-demo? This will write 3 changes ... The app cannot undo it."

**Session**:
A workspace holding an ordered list of **Tasks**, their results and their files. It belongs to the signed-in user: nobody else can open it.
_Avoid in code_: Thread, conversation, chat
_In the UI_: the list of them is "History"; one of them is a "topic", named by its first question ("Why is Service C Unhealthy? (11 Nov 14:05)").

**Directory**:
The Microsoft Entra tenant a user signs in to. Every subscription belongs to one, and the app shows a user the health models of the directory they signed in to. A personal Microsoft account has no directory of its own: it reaches Azure through one where it is a member or a guest.
_In code_: tenant, `tid`
_In the UI_: "directory".

## Relationships

- A **Session** holds many **Tasks**; a **Task** can build on the results of earlier **Tasks** in its **Session**.
- A **Review task** and a **Design task** each produce one **Health model diff**.
- An **Explain task** produces no **Health model diff**.
- A **Health model diff** gets one **Verification** before the user approves it.
- The user approves some or all changes of a **Health model diff**; an entity's signals and relationships are approved with it. Only approved changes are **Applied**.
- An **Apply** cannot be undone from the app.
- A **Session** is never deleted.
