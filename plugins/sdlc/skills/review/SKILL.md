---
description: Finish reviewing the current work item. Use at the review stage.
---

Each slice has already been reviewed, in `evidence/reviews/`. This step covers what those couldn't see.

If there's only one slice and no commits came after its review, copy its report to `evidence/review.md` in the work item folder. It doesn't need reading twice.

Otherwise, run `sdlc changed` to list the changed files. Spawn a `sdlc:reviewer`, giving it the work item folder and that list, and ask it to look at how the slices fit together and at any commits after the last slice. Use `/sdlc:team` for how. It can't write, so save its report as written to `evidence/review.md`.

If the verdict is `rework`, run `sdlc rework --reason "<the critical findings>"`, then use `/sdlc:next`.

If it's `pass`, commit the report and use `/sdlc:next`.
