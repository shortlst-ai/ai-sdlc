---
description: Build the current work item. Use at the build stage.
---

Read the slices in `plan.md`. Spawn one `sdlc:builder` per slice, telling each its slice and the work item folder. Run slices at the same time only if the plan says they don't overlap, because builders share this folder. Use `/sdlc:team` for how.

On the quick track there's no plan. Spawn one builder and give it the bug report and the failing test.

When a builder stops, a hook has already checked its diff and run the tests, and sends it back if they fail. If it gave up, tell the person.

Commit the work, run `sdlc check`, then run `sdlc advance`. That may raise the track if the real files call for it. Then use `/sdlc:next`.
