# ai-sdlc

An AI-native software factory for the whole development lifecycle, built as a Claude Code plugin named `sdlc`.

Status: early. It has shipped three real changes on one project. Installing from GitHub hasn't been tried, the deploy stage isn't built, and the maintain stage hasn't run on a live repo.

The factory moves each change through committed artifacts (`intent.md`, `spec.md`, `plan.md`, then code and evidence), so Git holds the state, the audit trail, and the handoffs between agents.

## How it works

Run `/sdlc:init` once in a repo. Then each change gets its own worktree, branch, and agent team:

```bash
claude --worktree add-export
```

```text
/sdlc:new add-export
```

`/sdlc:next` runs the next step, and the `sdlc` CLI decides what that is, not the model. A session stops only when it needs you.

| Track | For | You approve |
| --- | --- | --- |
| `quick` | A small fix | The merge |
| `standard` | A normal feature | The spec, and the merge only if the review didn't plainly pass |
| `critical` | Auth, payments, migrations | Every gate |

You merge every change yourself.

To approve, type `/sdlc:approve <name>` in any session on the repo. The session carries on by itself. `/sdlc:approve` on its own lists what's waiting, and `/sdlc:approve all` approves all of it. Only a person can do this: the model can't call it.

`sdlc gates` rechecks everything from the base branch in CI. Make `gates` a required check, using `plugins/sdlc/templates/sdlc-gates.yml`. That's the only control an agent can't bypass. The local hooks stop mistakes, not deliberate attempts.

## Watching CI

`plugins/sdlc/templates/sdlc-monitor.yml` checks CI on the default branch each day. If a workflow fails too often, it opens a pull request with a work item, so nobody has to notice first. Nothing gets built until a person approves the item.

Detection is plain code and needs no API key. With an `ANTHROPIC_API_KEY` secret, a read-only agent also adds a likely cause. The limits are in `.sdlc/config.json`, and your CI has to run on pushes to the default branch.

## Develop

```bash
npm run check   # tests and plugin validation
npm run evals   # real model calls, about $1
```

- Design: [docs/proposal.md](docs/proposal.md)
- Roadmap: [milestones](../../milestones)
- Work: [issues](../../issues)

## License

[MIT](LICENSE)
