# Phase 1 notes

What the first real runs showed, for the Phase 2 review. These are observations from one person's runs on `RCTResources`, so treat them as leads, not rates. This covers the run in progress on 2026-10-31.

## Timings

| Item | Track | Start to merge gate | Human approvals |
| --- | --- | --- | --- |
| `curate-file-type` | `quick` | About 17 minutes, including 8 stuck at a prompt | 1 |
| `openfda-labels` | `standard` | About 25 minutes of agent time, after spec approval | 2 |

## Ceremony and friction

- **Agents finish, then stop.** After an approval the session waits for `/sdlc:next` instead of continuing. It happened at every gate. This is the easiest thing to remove.
- **Attaching to a session is awkward.** Text typed in the wrong session goes to Claude as chat, and `Ctrl-a d` didn't work in the person's terminal. Approving from a `screen` session cost more than the approval itself. Consider a way to approve without attaching.
- **An idle prompt offers `/sdlc:approve` as a suggestion.** Pressing Enter could accept a gate the person meant to hold. The hook can't tell that apart from typing it.
- **Spec gates were worth their cost.** The labels spec surfaced a real decision about label text. Reading the harvester spec found a change that would have silently stopped future refreshes.
- **Specs ran long for the request.** The harvester brief grew to 25 acceptance criteria plus a ledger, exit codes, and a new flag. It was good work, but it's a lot to review at a gate.
- **Quick-track reviews can't be acted on cheaply.** The test lock stops the build from changing tests, so gaps the reviewer finds in them need a follow-up or rework.

## Gaps the runs found

- **Nothing landed work without a remote.** Fixed: `next` now runs the gates and hands over the merge.
- **A quick item couldn't add a file.** The fix needed a third file, and `sdlc track --files` didn't record it. Fixed: it now adds to the item and judges the track on all files.
- **A permission prompt can stall a session silently.** Reading the plugin's source outside the working directory stopped one run for 8 minutes. Agents shouldn't need that source, so the CLI help should answer those questions.
- **The `critical` track can't finish yet.** It has no `release` skill, so a repo can't safely configure critical paths.

## Small fixes to make

- `sdlc status` in the main checkout says "No work items yet" even when merged items exist.
- A stray folder under `.sdlc/work/` stops every command.
- `Gates passed for 1 work items.` has the wrong plural.
- Parallel items can share a number, such as `0001-a` and `0001-b`. Slugs keep them unique, but the numbers read as if they were ordered.
- `status` prints "Factory initialized at" as its heading.

## Worked well

- Each worktree built its own environment in about 40 seconds, and that fixed the shared-venv problem.
- The test lock and the scope check both refused bad changes during the dry runs, with clear reasons.
- Real agent teams ran each role in a `claude --worktree` session.
- Three items ran at the same time without touching each other.
