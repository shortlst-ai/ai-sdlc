---
description: Prepare a critical work item for release sign-off. Use at the release stage.
---

Write `evidence/release.md` in the work item folder, and commit it:

- **What ships:** the change in one or two sentences, and who it affects
- **Before release:** anything that has to happen first, such as a migration or a config change
- **How to tell it worked:** what to check, and where
- **How to roll back:** the exact steps, and anything that can't be undone

Say plainly if a section doesn't apply, and don't leave one out. If you don't know how to roll it back, say that too: it's what the person needs to hear.

Then show the file and ask the person to type `/sdlc:approve <name of this item>`. You can't approve it, and you don't release anything yourself. This session picks up by itself once they have.
