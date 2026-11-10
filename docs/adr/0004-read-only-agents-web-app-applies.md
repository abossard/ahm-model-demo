# Agents only read; the web app applies

Agent-generated code runs in the hosted session, where it can mint tokens as the agent identity. So the agent identity gets only read roles (Reader, Monitoring Reader, Log Analytics Reader) on this deployment's resource group, and session egress is limited to an allow-list of Azure endpoints and the Git host. Writing a health model happens only in the web app, with its own write role, after a user approves the diff. A prompt or a generated script can therefore read this resource group, but can neither change a model nor send data to an arbitrary host.
