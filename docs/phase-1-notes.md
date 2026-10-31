# Phase 1 notes

What the first real runs showed, for the Phase 2 review. These are observations from one person's runs on `RCTResources`, so treat them as leads, not rates. This covers the three runs of 2026-10-31. All three were merged with no rework.

## Timings

| Item | Track | Start to merge gate | Human approvals |
| --- | --- | --- | --- |
| `curate-file-type` | `quick` | About 18 minutes, including 8 stuck at a prompt | 1 |
| `openfda-labels` | `standard` | About 21 minutes after spec approval, plus about 6 for the spec | 2 |
| `harvester-termination` | `standard` | About 59 minutes after spec approval, plus the spec and one amendment | 2 |

## Ceremony and friction

- **Agents finish, then stop.** After an approval the session waited for `/sdlc:next` instead of continuing. Fixed: a background `Stop` hook wakes the session. Sessions started before the fix still need the nudge.
- **Attaching to a session was confusing.** Text typed in the wrong session went to Claude as chat, and `Ctrl-a d` didn't work in the person's terminal. Fixed: `/sdlc:approve <name>` now works from any session on the repo, and with no name it lists what's waiting.
- **An idle prompt offers `/sdlc:approve` as a suggestion.** Pressing Enter might accept a gate the person meant to hold. This isn't tested, so check it before relying on the gate.
- **Spec gates were worth their cost.** The labels spec surfaced a real decision about label text. Reading the harvester spec found a change that would have silently stopped future refreshes.
- **Specs ran long for the request.** The harvester brief grew to 25 acceptance criteria plus a ledger, exit codes, and a new flag. It was good work, but it's a lot to review at a gate.
- **Quick-track reviews can't be acted on cheaply.** The test lock stops the build from changing tests, so gaps the reviewer finds in them need a follow-up or rework.

## Gaps the runs found

- **Nothing landed work without a remote.** Fixed: `next` now runs the gates and hands over the merge.
- **A quick item couldn't add a file.** The fix needed a third file, and `sdlc track --files` didn't record it. Fixed: it now adds to the item and judges the track on all files.
- **A permission prompt can stall a session silently.** Reading the plugin's source outside the working directory stopped one run for 8 minutes. Agents shouldn't need that source, so the CLI help should answer those questions.
- **A lead can stall after a teammate reports back.** One rehearsal item with no brief stopped after its researcher finished and never wrote a spec. It hasn't been reproduced with a real brief, so watch for it.
- **Long-lived sessions lose their login.** A session waiting at a gate for about five hours came back "Not logged in", so a slow human gate can outlast the session. The work was safe, because finishing an item only needs the CLI, and a resumed session should pick up.
- **The `critical` track can't finish yet.** It has no `release` skill, so a repo can't safely configure critical paths.

## Small fixes to make

- `sdlc status` in the main checkout says "No work items yet" even when merged items exist.
- A stray folder under `.sdlc/work/` stops every command.
- `Gates passed for 1 work items.` has the wrong plural.
- Parallel items can share a number, such as `0001-a` and `0001-b`. Slugs keep them unique, but the numbers read as if they were ordered.
- `status` prints "Factory initialized at" as its heading.
- `sdlc metrics --since <date>` drops most of that day, because Git reads a bare date as that date at the current time of day.

## Worked well

- Each worktree built its own environment in about 40 seconds, and that fixed the shared-venv problem.
- The test lock and the scope check both refused bad changes during the dry runs, with clear reasons.
- Real agent teams ran each role in a `claude --worktree` session.
- Three items ran at the same time without touching each other.
- `/sdlc:approve <name>` worked from the VS Code panel on the first try, and a real session woke by itself and finished after approval.

## What the reviewer can't see

The reviewer has read-only tools, so it can't run anything. On the harvester item, a person's check found what it couldn't: the old-code bug was unproven until someone ran it, and a spec read at the gate was a draft that had changed by the time it was committed. A gate should show only committed text. Nothing enforces that yet.
