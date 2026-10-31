---
description: Hand the finished work item to a person. Use at the merge stage.
---

Show the person the review findings and the verify result.

If the repo has a remote, push this branch and open a pull request, naming the work item. Never merge it yourself.

Then ask the person to type `/sdlc:approve <name of this item>`, in this session or any other on this repo. This session picks up by itself once they have. If it doesn't, they can use `/sdlc:next`.
