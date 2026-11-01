---
description: Write the intent or spec for the current work item. Use at the intent and spec stages.
---

At the `intent` stage, spawn a `sdlc:spec-writer`, giving it the work item folder and what the person asked for.

At the `spec` stage, spawn a `sdlc:researcher` to map the code the change touches. Then spawn a `sdlc:spec-writer`, giving it the work item folder, the approved `intent.md`, and the findings.

Use `/sdlc:team` for how to spawn them. Check the file exists, commit it, and show the person any concerns it flags. Then use `/sdlc:next`.
