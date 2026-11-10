# Tasks replace the chat copilot

Agent work starts as a Task (Review, Explain or Design) from a form with a type, a target and an optional instruction, and ends in a structured result such as a health model diff. The CopilotKit chat in `src/agent-web` and the web app's `/agent` proxy are removed. The old copilot always read the default model and shared no context with the graph, and keeping it next to tasks would mean two agent stacks. Follow-ups are new tasks in the same Session, not chat messages.
