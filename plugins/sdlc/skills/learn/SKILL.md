---
description: Turn repeat review findings into rules so they stop happening. Use when asked what the factory has learned, or after several work items finish.
---

Read `evidence/review.md` for each finished item under `.sdlc/work/`, and `evidence/rework-*/` if there are any. Read the repo's `CLAUDE.md` and `REVIEW.md` if it has them.

Find mistakes that came up in two or more items. One finding is an incident, so leave it out. Skip anything an existing rule already covers.

For each repeat, recommend the cheapest place that stops it:

| Where | When |
| --- | --- |
| A test or lint rule | The mistake can be caught by a machine. Prefer this |
| A hook | It has to be stopped as it happens |
| `REVIEW.md` | A person or reviewer needs to look for it |
| `CLAUDE.md` | It's a convention the agents keep getting wrong |

Report each one in this form, most frequent first:

- **The mistake**, in one line
- **Seen in**, naming the items
- **The rule**, worded as it would appear
- **Where it goes**, and why not somewhere cheaper

If nothing repeats, say so. Don't invent rules to look useful, because each one adds to what every session has to read.

Don't change anything yourself. Adding a rule is a change like any other, so it starts with `/sdlc:new`.
