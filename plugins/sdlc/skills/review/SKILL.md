---
description: Review the current work item with a reader who didn't write it. Use at the review stage.
---

Run `sdlc changed` to list the changed files. Spawn a `sdlc:reviewer`, giving it the work item folder and that list. Use `/sdlc:team` for how.

The reviewer can't write, so save its report as written to `evidence/review.md` in the work item folder.

If the verdict is `rework`, run `sdlc rework --reason "<the critical findings>"`, then use `/sdlc:next`.

If it's `pass`, commit the report and use `/sdlc:next`.
