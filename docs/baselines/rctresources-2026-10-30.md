# Baseline: RCTResources

Captured 2026-10-30 at commit `d99ddb3`, before the factory was used on this repo. Compare against it at the Phase 2 review.

To reproduce the Git figures, run this from a checkout of that repo:

```bash
sdlc metrics --json
```

## What this is a baseline of

**Claude Code without the factory, not development without AI.** 13 of the 19 commits are co-authored by Claude. Any improvement has to come from the process, not from adding an AI tool.

## Results

| Measure | Value |
| --- | --- |
| Period | 2026-08-17 to 2026-08-31 |
| Commits | 19, on 4 active days out of 15 |
| Commits per active day | 4.75 |
| Median change | 6 files, 777 lines |
| Largest change | 1,823 lines |
| Commits with "fix" wording | 1 (5%) |
| Reverts | 0 |
| Commits touching tests | 14 (74%) |
| Merges | 0 |

Quality at capture:

| Check | Result |
| --- | --- |
| `pytest` | 349 passed in about 57s |
| `ruff check` | Clean |
| `mypy src` | Clean, 31 files |

## How far to trust it

- **The sample is small.** 19 commits from one person in four sittings. Treat these as a description of this history, not as a rate.
- **The work was mostly new code.** Many commits build a whole pipeline phase, which is why changes are large. Later work on an established repo will naturally look different, so a change in size isn't automatically the factory's doing.
- **The fix count is a weak signal.** It matches words in commit subjects. A fix described another way isn't counted, so the 5% is a floor.
- **Commit time isn't lead time.** Commits show when work was recorded, not how long it took.

## What the baseline can't cover

Section 8 of the proposal has seven questions. Only part of that can be measured here, because this repo has no remote, PRs, CI, or incident tracker.

| Question | Before the factory | From the factory onward |
| --- | --- | --- |
| Is it faster? | Not measurable | Time between stages, from each item's history |
| Is it right the first time? | Fix wording only | Rework count per item |
| Is review keeping up? | Not measurable, no PRs | Change size here; review wait needs PRs |
| Is it safe? | Reverts only | Reverts and escaped defects, recorded by hand |
| Is the spec useful? | Not applicable | Spec edits after build starts |
| Is it learning? | Not measurable | Repeat findings after `/sdlc:learn` |
| Is it worth the cost? | Not captured | Tokens per finished item |

Most of the factory's value will show up in columns that have no "before". So the Phase 2 review should rely on the factory's own numbers across several items, plus an honest judgment of whether the process felt worth it, and use this file mainly as a sanity check on size and fix rate.
