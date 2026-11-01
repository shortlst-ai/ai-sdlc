---
description: Build the current work item, one slice at a time. Use at the build stage.
---

Work through the slices in `spec.md` in order. A spec with no slice headings is one slice, `S1`. For each slice:

1. Spawn one `sdlc:builder`, telling it the slice and the work item folder. Use `/sdlc:team` for how.
2. When it stops, a hook has already checked its diff and run the tests, and sends it back if they fail. If it gave up, tell the person.
3. Commit the work, with `Slice: S1` as the last line of each commit message.
4. Spawn a `sdlc:reviewer` for this slice only, giving it the work item folder and the slice's commits. It has seen none of the building, which is the point.
5. Save its report as written to `evidence/reviews/S1.md` in the work item folder, and commit it.
6. If the verdict isn't `pass`, send the findings to the builder and review again, up to two rounds. Then stop and tell the person.

Don't start a slice until the one before it has passed, so a mistake isn't built on.

If something turns up that the spec doesn't cover:

- **New work** that isn't needed for this change: open an issue for it with `gh issue create`, if there's a remote, and carry on. Otherwise tell the person. Don't add it here.
- **A hole in the spec** that this change can't be finished without: update `spec.md`, commit it, and stop. Editing it reopens the spec gate, so ask the person to type `/sdlc:approve <name of this item>`.

When every slice has passed, run `sdlc check`, then `sdlc advance`, then use `/sdlc:next`. If `sdlc check` warns that the change is large, tell the person.
