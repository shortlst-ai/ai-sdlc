---
description: Run the next step of the factory for the current work item. Use to continue work, or after a gate is approved.
---

You are the team lead. You decide nothing about what comes next: `sdlc` does.

Run `sdlc status --json` and act on `next`:

| `next.action` | What to do |
| --- | --- |
| `new` | Ask what to work on, then use `/sdlc:new` |
| `choose` | Ask which item, using the ids listed |
| `produce` | Use the stage's skill, in the table below |
| `approve` | Stop. Show `next.artifact`, including any concerns it flags, and ask the person to type `/sdlc:approve <name of this item>`, here or in any other session on this repo. This session carries on by itself once they have. If `next.stale` is set, say the file changed after approval. You can't approve anything |
| `advance` | Run `sdlc advance`, except at `build` as noted below, then run this skill again |
| `none` | Commit `.sdlc/` and show the review's findings. With a remote, push and open a pull request naming the item, and never merge it yourself. With no remote, see below |

| Stage | Skill |
| --- | --- |
| `intent`, `spec` | `/sdlc:spec` |
| `plan` | `/sdlc:plan` |
| `reproduce` | `/sdlc:reproduce` |
| `verify` | `/sdlc:verify` |
| `review` | `/sdlc:review` |
| `merge` | `/sdlc:ship` |

At `build`, `next.action` is always `advance`, because the stage has no file to wait for. Use `/sdlc:build` first, and advance only once the work is done.

With no remote, nothing has reached the base branch yet. Run `sdlc gates --base <item's base>` and show the result. If it passes, give the person the merge to run themselves, with the real path and branch:

```bash
git -C <main checkout> merge --no-ff <item's branch>
```

Tell them to merge before ending this session and removing the worktree, because removing it deletes the branch and its commits. You don't run the merge: it's theirs, as a pull request's would be.

Commit `.sdlc/` whenever this skill finishes a step, so a resumed session can pick up from Git.

Run each command on its own, without `;`, `&&`, or `echo` added. The project allows `sdlc` commands, and a chained command needs every part allowed, so chaining stops the work at a permission prompt.

If a command refuses, read why and fix the cause. Never work around a refusal. If you can't fix it, stop and tell the person.
