---
description: Add a diagnosis to a work item opened by sdlc breach. Use at the intent stage of a breach item.
---

Spawn a `sdlc:diagnoser`, giving it the work item folder. Use `/sdlc:team` for how.

It can't write, so replace the `## Unknown` section of `intent.md` with its report as written, under a heading of `## Diagnosis`. Commit it.

Then stop and ask the person to type `/sdlc:approve <name of this item>`. A diagnosis is a suggestion. The person decides whether this is worth fixing.
