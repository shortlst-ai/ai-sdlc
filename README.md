# ai-sdlc

A software factory for Claude Code. `sdlc` is a plugin that takes each change from an idea to a merged pull request through agents, tests, and review, and stops only when it needs you.

- **Git holds everything.** Specs, plans, approvals, and evidence are committed files, so work survives a closed session and leaves an audit trail.
- **Code decides what happens next, not the model.** The `sdlc` CLI runs a state machine, and agents can't skip a step by claiming it's done.
- **You stay in charge.** Only a person can approve a gate, and only a person merges.

> **Status: early.** It has shipped three real changes on one project. See [What's proven](#whats-proven) before you rely on it.

## How it works

Each change gets a track, which sets how much process it goes through. The track comes from your config and the files involved, and can go up but never down.

```mermaid
flowchart TD
    start([New change]) --> track{Which track?}

    track -->|Small fix| reproduce[Write a failing test]
    track -->|Normal feature| spec[Write the spec]
    track -->|Auth, payments, migrations| intent[Write the intent]

    intent --> gateIntent{{You approve}}
    gateIntent --> spec
    spec --> gateSpec{{You approve}}
    gateSpec --> plan[Plan the slices]
    plan --> build
    reproduce --> build[Build]

    build --> verify[Verify: tests and scope]
    verify -->|Fails| build
    verify --> review[Independent review]
    review -->|Critical findings| build
    review --> gateMerge{{You approve, unless a standard change passed review}}
    gateMerge --> done([You merge the pull request])
    gateMerge -->|Critical only| gateRelease{{You approve the release}}
    gateRelease --> done

    classDef you fill:#fde68a,stroke:#b45309,color:#1f2937
    class gateIntent,gateSpec,gateMerge,gateRelease,done you
```

The yellow steps are yours. Everything else runs by itself.

| Track | For | You approve |
| --- | --- | --- |
| `quick` | A small fix, in up to three files | The merge |
| `standard` | A normal feature | The spec, and the merge only if the review didn't plainly pass |
| `critical` | Auth, payments, migrations | Intent, spec, plan, merge, and release |

Inside a change, your session leads a team of agents. Each role can only do its own job: the reviewer can't edit, and the verifier can only write tests.

```mermaid
sequenceDiagram
    actor You
    participant Lead as Your session
    participant Team as Agent team
    participant CLI as sdlc CLI
    participant CI as GitHub

    You->>Lead: /sdlc:new add-csv-export
    Lead->>CLI: What's next?
    CLI-->>Lead: Write the spec
    Lead->>Team: Researcher and spec writer
    Team-->>Lead: spec.md
    Lead-->>You: Please review the spec
    You->>CLI: /sdlc:approve add-csv-export
    CLI-->>Lead: Approved, carry on
    Lead->>Team: Planner, builders, verifier, reviewer
    Team-->>Lead: Code, tests, and evidence
    Lead->>CI: Open a pull request
    CI->>CI: sdlc gates rechecks everything
    You->>CI: Merge
```

## Tutorial: your first change

This walks through adding a CSV export to a project. You need Claude Code, Node 20 or later, and a Git repo.

### 1. Install the plugin

From your repo:

```bash
claude plugin marketplace add shortlst-ai/ai-sdlc
claude plugin install sdlc@ai-sdlc --scope project
```

`--scope project` turns the plugin on for this repo only.

### 2. Set up the factory

Run `claude`, then:

```text
/sdlc:init
```

It finds your setup, test, and format commands, and asks which paths are critical or protected. Then commit what it created, because worktrees can't see it until you do:

```bash
git add .sdlc .claude/settings.json .gitignore
git commit -m "Adopt the software factory"
```

### 3. Turn on the CI gate

The local checks stop mistakes. This one stops everything else, because it runs where an agent can't reach it.

```bash
mkdir -p .github/workflows
curl -o .github/workflows/sdlc-gates.yml \
  https://raw.githubusercontent.com/shortlst-ai/ai-sdlc/main/plugins/sdlc/templates/sdlc-gates.yml
```

Then, in your repo's branch protection settings, make `gates` a required check on your default branch.

### 4. Start the change

Every change gets its own worktree, branch, and session. Run this in a terminal, because agent teams need one:

```bash
claude --worktree add-csv-export
```

Then, in that session:

```text
/sdlc:new add-csv-export

Let people export the orders table as CSV.
```

The session builds its own environment, and agents research the code and write `spec.md`.

### 5. Approve the spec

The session stops and shows you the spec, including anything it wants you to decide. If you'd change something, say so, and it updates the spec. When it's right:

```text
/sdlc:approve add-csv-export
```

You can type this in any Claude session on the repo, so one window can handle all your work. Typing `/sdlc:approve` alone lists what's waiting, and `/sdlc:approve all` approves all of it.

An approval is tied to the exact text you approved. If the spec changes afterward, the gate reopens.

### 6. Let it run

The session picks up by itself. It plans the work, builds it, runs your tests, and checks the change against the plan. An independent reviewer then reads the result.

If a step fails, it goes back and fixes it, up to a limit. If it hits that limit, it stops and tells you. You can check on it at any time:

```text
/sdlc:status
```

### 7. Merge

When the review passes, the session opens a pull request. Read it, check that `gates` is green, and merge it yourself.

If your repo has no remote, the session gives you a `git merge` command instead. Run it before you end the session, because removing a worktree deletes its branch and any unmerged commits.

### A smaller change

For a small fix, name the files so the factory can see it's small:

```text
/sdlc:new fix-date-format src/dates.py,tests/test_dates.py
```

That puts it on the `quick` track. The session writes a failing test first, and the test is then locked, so the fix can't change it to pass.

## Commands

| Command | What it does |
| --- | --- |
| `/sdlc:init` | Sets up the factory in a repo |
| `/sdlc:new <name>` | Starts a change in the current worktree |
| `/sdlc:next` | Runs the next step |
| `/sdlc:status` | Shows work items and what each one needs |
| `/sdlc:approve [name]` | Records your approval. People only |
| `/sdlc:abandon [id] <reason>` | Closes a change, keeping it on record. People only |
| `/sdlc:learn` | Turns mistakes that repeat across changes into suggested rules |
| `/sdlc:diagnose <id>` | Adds a likely cause to a CI breach |

The model can't run `approve` or `abandon`. They work only when a person types them.

## Watching CI

`sdlc-monitor.yml` checks CI on your default branch each day. If a workflow fails too often, it opens a pull request with a work item, so nobody has to notice first. Nothing gets built until you approve that item.

Copy it from `plugins/sdlc/templates/` as you did in step 3. Your CI has to run on pushes to the default branch, and you have to allow GitHub Actions to create pull requests. Detection is plain code and needs no API key. With an `ANTHROPIC_API_KEY` secret, a read-only agent also adds a likely cause.

The limits are in `.sdlc/config.json`.

## What protects your code

```mermaid
flowchart LR
    agent([Agent]) --> plugin[Plugin hooks<br/>Stop mistakes]
    plugin --> repo[Committed files<br/>Can be reviewed]
    repo --> server[CI and branch protection<br/>Can't be bypassed]
    server --> main([Default branch])

    classDef wall fill:#bbf7d0,stroke:#15803d,color:#1f2937
    class server wall
```

The first two layers keep an honest agent on track, but they run on your machine, so a determined one could get around them. **The CI check is the real boundary**, so turn it on.

## What's proven

This is new software, so here's what has and hasn't been tested.

**Tested on real work**

- Three real changes went through the factory on one project, with no rework
- Forged approvals and a gutted gate were both blocked on GitHub
- `/sdlc:approve` works from the terminal and the VS Code panel
- Installing from GitHub works

**Not proven yet**

- **The deploy stage isn't built.** It's parked until there's a project to deploy, and a way to separate the agent from the approver
- **The CI monitor hasn't run on a live repo.** Its commands are tested, but the workflow itself hasn't run
- **Some attacks are only tested locally.** Deleting `.sdlc/` is refused on a fresh clone, but hasn't been tried on GitHub, and neither has a pull request that edits `sdlc-gates.yml`
- **A pull request that only changes `.sdlc/config.json` passes the gate,** so review that file whenever it changes
- **Forged approvals can pass on a solo repo.** An approval with the right hash and a made-up name passes `sdlc gates`, so on a team, pull request review is the real sign-off
- **The diagnoser isn't fully resistant to instructions planted in CI logs.** It ignored them in 7 of 8 test runs, and the eighth is unexplained

Agent teams are experimental in Claude Code and need a terminal session. In the VS Code panel, the same roles run as plain subagents.

## Develop

```bash
npm run check   # tests and plugin validation
npm run evals   # real model calls, about $1
```

- Design: [docs/proposal.md](docs/proposal.md)
- Notes from the first real runs: [docs/phase-1-notes.md](docs/phase-1-notes.md)
- Roadmap: [milestones](../../milestones)

## License

[MIT](LICENSE)
