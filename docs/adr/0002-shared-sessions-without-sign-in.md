# Shared sessions without sign-in, with live Apply

The app stays public with no sign-in. All visitors see and open the same Sessions, and anyone can approve and Apply a health model diff to live models. This keeps the demo frictionless for presenters, at a deliberate risk: any visitor can change a model. That risk is bounded, not removed. Apply writes only to models in this deployment's resource group and refuses if the live model changed since the diff's base. Sessions are never deleted, so no visitor can wipe a prepared demo. There is no undo; `azd provision` restores Bicep-defined parts.
