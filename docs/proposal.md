# AI-native software factory: proposal

Status: proposal, not yet built. Date: 2026-10-30.

**Recommendation:** build a Claude Code plugin called `sdlc`, but treat it as one of three layers. The plugin holds the agents, skills, and local gates. Your repo holds the config and the artifact chain. CI and branch protection hold the only gates an agent cannot get around. The core is small: a state machine over versioned artifacts, plus gates that check those artifacts. Everything else (TDD skills, code review, CI runners) should be reused, not rebuilt.

Evidence labels used below:

- **[V]** verified in a local spike (section 3)
- **[D]** stated in the official docs
- **[A]** assumption, still to be proven

---

## 1. What the references give us

| Source | What it contributes | What it leaves out |
| --- | --- | --- |
| [AI-Native SDLC Playbook](https://academy.claude.com/courses/ai-native-sdlc-playbook) (14 lessons, 12 plays) | The full six-stage loop, the committed-artifact chain, skill vs. hook strength, sigma-tiered response, per-play metrics | It describes patterns, not an implementation. No orchestrator or state model. Assumes an enterprise with named roles |
| [freeCodeCamp handbook](https://www.freecodecamp.org/news/how-to-build-software-factory-with-claude-code/) | Five layers, the agent chain, tool restriction, critical-finding loop, stacked PRs, tuning after each run | Stops at the PR. Tied to a web stack. State lives in the chat |
| [az9713/software-factory](https://github.com/az9713/software-factory) | A concrete implementation of the handbook: 9 agents, 2 skills, 1 hook script | See the defects below. Not a plugin. No maintain stage |
| [yibie/ai-native-sdlc-playbook](https://github.com/yibie/ai-native-sdlc-playbook/blob/main/book.md) | Readable offline copy of the course | Third-party copy of Anthropic's content, so it adds nothing beyond the course |

The most useful idea across all of them is the playbook's: **each stage ends by committing an artifact, and the next stage starts by reading it.** That makes Git the state store, the audit trail, and the resume point. The factory is designed around this.

### Defects in the reference implementation

These are the reason not to fork it. Each was checked against the repo files and the hooks docs.

| Finding | Why it matters |
| --- | --- |
| `pre-commit.sh` ends in `exit 1`; the `Stop` hook is `npm run typecheck && npm test`, which also exits 1 on failure | Exit 1 is a **non-blocking error** [D]. Only exit 2 (or a JSON decision) blocks. Both gates look enforced and enforce nothing |
| The secrets check reads `git diff --cached` before the Bash command runs | `git add .env && git commit` in one command evades it even if the exit code were fixed |
| Docs say `Stop` runs "after each agent finishes" | `Stop` fired only for the main session [V]. Subagents need `SubagentStop` |
| README says write agents have no arbitrary shell; `backend-builder` frontmatter lists `Bash` | The stated restriction doesn't exist |
| "Restricted to backend folders" is prompt text only | Scope is advisory |
| "Never skip the human approval points" is prompt text only | The gates that matter most are the weakest |
| `feature-orchestrator` is a subagent | `AskUserQuestion` is removed from subagents [D], so it has no way to pause for a human |
| `npm run lint --fix \|\| true`, matcher `Edit` only | `--fix` goes to npm, not the linter; failures are swallowed; `Write` is missed |

Licensing: the repo's file tree has no LICENSE, so treat it as all rights reserved. Reimplement the ideas and don't copy files.

---

## 2. Landscape and where this fits

| Tool | Coverage | How it holds the line | Takeaway |
| --- | --- | --- | --- |
| [Superpowers](https://github.com/obra/superpowers) | Design to branch finish | Skills described as mandatory; bootstrap injected at session start | Best at keeping an agent disciplined while coding. Reuse, don't compete |
| [Compound Engineering](https://github.com/EveryInc/compound-engineering-plugin) | Brainstorm to review, plus "compound" | Skills; learnings saved to `docs/solutions/` | Adopt the learning step |
| [Spec Kit](https://github.com/github/spec-kit) | Constitution to implement, with a converge check | Workflows, presets, extensions | Presets are a good model for policy packs. Böckeler found its output verbose and tedious to review |
| [BMAD](https://github.com/bmad-code-org/BMAD-METHOD) | Planning personas to delivery, with an unattended epic loop | Structured workflows; planning scales with size | Scaling ceremony to the size of the change is right |
| [StrongDM factory](https://simonwillison.net/2026/feb/7/software-factory/) | No human code or review | Hidden scenarios, satisfaction scoring, digital twins | Take hidden scenarios. Reject the rest: no human review, and about $1,000 per engineer per day in tokens |

**The gap this project fills.** From reading these projects' READMEs (not their full source), none combines all of the following:

- the full loop, including deploy and maintain
- gates that check the artifact, not the agent's word
- a server-side re-check the agent can't touch

**The main criticism to design for** is ceremony. [Böckeler's review](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html) found Kiro turned a small bug into 4 user stories and 16 acceptance criteria ("a sledgehammer to crack a nut"), and Spec Kit produced repetitive Markdown that was tedious to review. Fowler and Beck argue that AI should shorten the feedback loop, not justify more upfront documents (I only saw that second-hand). Section 5 answers this with tracks.

**The evidence is weak.** I found no controlled productivity data for spec-driven development, and the figures that circulate (19% slower to 55% faster) come mostly from secondary sources. So the factory has to measure its own effect (section 8), starting with a baseline before rollout.

---

## 3. What the spike proved

I built a throwaway plugin and ran it on Haiku, at a cost well under a dollar. At the time, the `claude` on PATH was 2.1.280 and the VS Code session was 2.1.314. Tests marked 314 used a scratchpad install of that version. The global install has since been updated to 2.1.314.

| # | Question | Result | Consequence |
| --- | --- | --- | --- |
| 1 | Do plugin hooks fire inside plugin subagents? | **Yes**, with `agent_type: "fspike:reader"` (280) | Per-role gates work, and the plugin namespace must be matched |
| 2 | Does exit 2 block a subagent's tool call? | **Yes**, file was not created (280) | |
| 3 | Does the `tools` allowlist hold? | **Yes**, read-only role could not write (280) | Reviewers can be made truly read-only |
| 4 | Can a role dodge a path-based `Write` gate? | **Yes**, it used `echo > file` in Bash (280) | **Path gates are a speed bump, not a control** |
| 5 | Can `SubagentStop` catch that from the real diff? | **Yes**, it blocked and the agent removed the file (280) | Check the diff, not the intent to write |
| 6 | Are `Workflow`s available by default? | **No** on this account, on either version | They default to off on Pro [D], and `Workflow` was absent here. Treat as optional |
| 7 | Does `enableWorkflows: true` fix that? | **Yes**, and a plugin workflow ran (314) | Opt-in works |
| 8 | Do hooks fire in workflow agents? | **Yes**, as `workflow-subagent` (314) | An untyped agent has no role identity |
| 9 | Does `agentType` keep the role in a workflow? | **Yes**, `fspike:builder` (314) | Always pass `agentType` |
| 10 | Can the model trigger a `disable-model-invocation` skill? | **No**, and no approval was written (280) | |
| 11 | Does a typed command fire `UserPromptExpansion`? | **Yes**, the hook wrote the approval (280) | Approval can be recorded outside the model |

Also learned: a skill and a workflow with the same name appear to collide, since calling `fspike:hello` failed until the skill was removed.

**Constraints from the docs that shape the design [D]:**

- A plugin's `settings.json` honors only `agent` and `subagentStatusLine`. **A plugin cannot ship permissions or sandbox rules.**
- Plugin agents ignore `hooks`, `mcpServers`, and `permissionMode` in frontmatter.
- Plugin hooks fire in every session once enabled, so they must exit immediately in repos that don't use the factory.
- Workflows take no mid-run user input. The docs say to run each stage as its own workflow when you need sign-off between stages.
- Plugin monitors don't start under `claude -p`.
- A hook's `ask` becomes a denial in headless runs, and a hook's `allow` doesn't override deny rules.
- A plugin with a top-level `bin/` won't install on claude.ai or Cowork.
- Under `allowManagedHooksOnly`, plugin hooks run only if managed settings force-enable the plugin.

---

## 4. Architecture

Each layer answers a different question, and only the bottom one holds against an agent that goes around the rules.

```text
 LAYER 1  PLUGIN (sdlc)            "make the right thing easy"
   skills, agents, local hooks, sdlc CLI
   Stops honest mistakes and drift. Fast feedback. Can be bypassed.
        |
 LAYER 2  REPO                     "make it reviewable and repeatable"
   .sdlc/ config and work items, CLAUDE.md, REVIEW.md, .claude/settings.json
   Versioned, code-owned. Permissions and sandbox rules live here.
        |
 LAYER 3  SERVER                   "make the wrong thing impossible"
   Required CI check, branch protection, CODEOWNERS, managed settings
   Re-verifies everything from the artifacts. Agents hold no merge rights.
```

**Threat model, stated plainly.** Layers 1 and 2 defend against mistakes, drift, and a well-meaning agent cutting corners. They do not stop an agent actively working around them, as test 4 shows. Layer 3 is the boundary. Any policy that must always hold needs a check at Layer 3, and a Layer 1 hook is only there to give faster feedback.

### Key decisions

**State lives in Git, not in chat.** Each work item is a folder. Any fresh session can resume from it. This also gives you the context reset between stages that the handbook recommends.

**Orchestration is a thin main-session skill plus a deterministic CLI.** `/sdlc:next` asks `sdlc status --json` what to do, then runs that stage. The script decides the next step, never the model. This follows from test 6 and the constraints: subagents can't ask humans, and workflows can't pause for them. Workflows remain an optional accelerator *inside* a stage, such as multi-pass review, with a sequential fallback.

**Approvals bind to content.** `/sdlc:approve` is human-only (tests 10 and 11). A hook records the SHA-256 of the artifact plus the approver. If the spec changes afterward, the approval no longer matches and the gate reopens. You approve the bytes, not the stage.

**Scope comes from the plan, not from role names.** One stack-neutral `builder` replaces `backend-builder` and `frontend-builder`. `plan.md` declares which files each slice may touch, and `SubagentStop` compares that to the real diff (test 5). This is what makes the factory work on any stack.

**Hooks stay fast.** Formatters run per file. The full test suite runs at `SubagentStop` for builders, not on every `Stop`, since that fires every turn. Every blocking loop has a retry budget, then escalates to a human.

---

## 5. Lifecycle

```text
 intent --G1--> spec --G2--> plan --G3--> build <-> verify --> review --G4--> release --G5--> observe
    ^                                                                                           |
    +-------------------------- band breach writes a new intent.md <----------------------------+
```

| Gate | Passes when | Decided by | Enforced at |
| --- | --- | --- | --- |
| G1 Intent | Problem and constraints are right | Product owner | Approval hash; CI re-check |
| G2 Spec | Solves the intent; flagged concerns resolved | Product owner, policy owner if flagged | Approval hash; CI re-check |
| G3 Plan | Files, order, tests, and rollback are concrete | Engineer, tech lead if high risk | Approval hash; no source edits before this |
| Verify | Tests pass; scope matches the plan; tests unedited on fixes | Deterministic | `SubagentStop`, then required CI check |
| Review | No critical findings; diff matches spec and plan | Read-only reviewer, then a person | Report only. Humans approve |
| G4 Merge | Code owner approves | Human | Branch protection |
| G5 Release | Named release authorization | Release manager | Environment protection in CI |

### Tracks, to keep ceremony in proportion

The track comes from `.sdlc/config.json` path rules, not from the model's judgment. The model may raise the track but never lower it.

| Track | For | Stages | Human gates |
| --- | --- | --- | --- |
| `quick` | Small bug or tweak | Failing test, fix, verify, review | Merge only |
| `standard` | Normal feature | Combined intent and spec, plan, build, verify, review | Spec, merge |
| `critical` | Auth, payments, migrations, regulated code | All stages, hidden scenarios, line-by-line human review | All five |

The `quick` track borrows the playbook's rule for bug fixes: commit a failing test first, then lock test files during the fix.

---

## 6. What gets built

### Plugin layout

```text
ai-sdlc/                         this repo: a marketplace holding the plugin
├── .claude-plugin/marketplace.json
├── docs/proposal.md
└── plugins/sdlc/
    ├── .claude-plugin/plugin.json
    ├── bin/sdlc                 CLI entry point (Node, no dependencies)
    ├── lib/                     state machine, gates, metrics
    ├── skills/
    │   ├── init/  next/  status/       setup and orchestration
    │   ├── intent/  spec/  plan/       Plan and Design stages
    │   ├── build/  verify/  review/    Build and Test stages
    │   ├── ship/  approve/             Deploy stage (approve is human-only)
    │   └── learn/                      turn repeat mistakes into rules
    ├── agents/                  researcher, planner, spec-writer, builder,
    │                            verifier, reviewer, diagnoser
    ├── hooks/hooks.json
    ├── scripts/                 hook handlers, each with fixture tests
    ├── templates/               config, REVIEW.md, GitHub workflows
    ├── workflows/               optional fan-out review
    └── evals/                   claude plugin eval suites
```

Skill and workflow names must not overlap (section 3).

### In the target repo, created by `/sdlc:init`

```text
.sdlc/
├── config.json                  commands, tracks, protected paths, limits
├── bands.yaml                   maintain-stage control bands (later phase)
└── work/0042-claims-status/
    ├── intent.md  spec.md  plan.md
    ├── state.json               written only by the CLI
    ├── approvals/               hash, approver, timestamp
    └── evidence/                test output, review findings
CLAUDE.md   REVIEW.md   .github/workflows/sdlc-*.yml
```

```json
{
  "version": 1,
  "commands": { "verify": "make test", "format": "make fmt FILE={file}" },
  "tracks": {
    "critical": { "paths": ["src/auth/**", "migrations/**"] },
    "quick": { "max_files": 3 }
  },
  "protected": ["src/gen/**"],
  "tests": ["tests/**", "**/test_*.py"],
  "limits": { "rework": 3 }
}
```

The config is JSON, not YAML. Node has no built-in YAML parser, and a hand-written or third-party one is a poor fit for a dependency-free CLI reading the file that defines protected paths, where a silent misparse would weaken a rule.

### Agents

| Agent | Tools | Model | Boundary |
| --- | --- | --- | --- |
| `researcher` | Read, Grep, Glob | haiku | Never edits |
| `spec-writer` | Read, Grep, Glob, Write | sonnet | `.sdlc/` only |
| `planner` | Read, Grep, Glob, Write | opus | `.sdlc/` only |
| `builder` | Read, Edit, Write, Bash | sonnet | Plan scope; no tests on fix tasks |
| `verifier` | Read, Edit, Write, Bash | sonnet | Test files only; reports, never patches |
| `reviewer` | Read, Grep, Glob | sonnet | Cannot edit, so it cannot approve its own work |
| `diagnoser` | Read, Grep, Glob, Bash | sonnet | Read-only intent; runs under restricted CI credentials |

### Hooks

| Event | Purpose |
| --- | --- |
| `SessionStart` | Show the active work item; exit at once if there's no `.sdlc/` |
| `PreToolUse` Write/Edit | Allow source edits only during build, so a change after verify needs rework. Block protected paths and agent writes to `approvals/`, `state.json`, and the config |
| `PreToolUse` Bash | Block `git push` to main, `--no-verify`, `gh pr merge`, and staged secrets. Best effort, backed by CI |
| `PostToolUse` Write/Edit | Run the formatter on the changed file |
| `SubagentStop` builder | Compare the diff to plan scope, run verify, block with the reason, retry within budget |
| `UserPromptExpansion` | Record approvals for `/sdlc:approve` |

### CI templates (Layer 3)

| Workflow | Job |
| --- | --- |
| `sdlc-gates.yml` | **Required check.** Recomputes approval hashes, confirms the diff is within plan scope, confirms the right artifacts exist for the track, and rejects test edits on fix tasks. This is what makes the local gates real |
| `sdlc-review.yml` | Review against `REVIEW.md`, using `claude-code-action` or managed Code Review |
| `sdlc-evals.yml` | Run `claude plugin eval` when skills, hooks, or `CLAUDE.md` change |
| `sdlc-monitor.yml` | Later phase: cron detection, `claude -p` diagnosis, opens an intent PR |

### Reuse rather than build

- **Review:** the official `code-review` plugin or managed Code Review, configured by `REVIEW.md`.
- **CI execution:** `claude-code-action`, which already installs plugins through its `plugin_marketplaces` and `plugins` inputs.
- **Coding discipline:** Superpowers or Compound Engineering can run alongside this. Document it as optional and avoid a hard plugin dependency.

### Ideas to take from each source

- **Playbook:** the artifact chain, sigma tiers, deterministic detection, and an eval for every incident.
- **Handbook:** the critical-finding loop, and one feature per PR.
- **Compound Engineering:** `/sdlc:learn`. Decide whether each repeat mistake belongs in `CLAUDE.md`, a skill, or a hook.
- **StrongDM:** hidden scenarios for the `critical` track. These must live outside the repo to work, because a read gate can be bypassed through Bash, just as a write gate can.

---

## 7. Roadmap

Effort figures are rough, for one person working with Claude.

| Phase | Scope | Exit criteria | Effort |
| --- | --- | --- | --- |
| **0. Foundation** | Marketplace skeleton, `sdlc` CLI and state machine, hook fixture tests. Capture a baseline on the target repo | CLI tests pass; `claude plugin validate --strict` passes; baseline recorded | 2-3 days |
| **1. Core loop** | `standard` track, intent to PR, approvals, scope check, `sdlc-gates.yml` | 3 real changes completed on `RCTResources` through the local gates; a deliberate gate bypass is caught by CI on this repo | 1-2 weeks |
| **2. Tracks and learning** | `quick` and `critical` tracks, review integration, `/sdlc:learn`, evals, metrics | A small fix takes under 15 minutes of human time; eval suite runs in CI | 1-2 weeks |
| **3. Deploy** | Environment tiers, release authorization, rehearsed rollback | Agent can reach production's gate and cannot pass it, proven by test | 1-2 weeks |
| **4. Maintain** | `bands.yaml`, detection on CI failure rate, intent-writing diagnoser | A real breach becomes an intent PR with no human starting it | 1-2 weeks |
| **5. Scale** | Policy packs, intent plugin for non-engineers (no `bin/`), Jira/ServiceNow sync, managed-settings profile, hidden scenarios | Second team adopts it without help | Later |

Stop after Phase 2 and review the metrics. If the factory isn't beating the baseline, fix that before extending the loop.

---

## 8. How we'll know it works

All of these come from Git, the PR history, and CI.

| Question | Metric | Warning sign |
| --- | --- | --- |
| Is it faster? | Lead time from intent to merge, per stage | Time just moved into gate waits |
| Is it right the first time? | First-pass CI rate, rework cycles per change | Rising with volume |
| Is review keeping up? | Time to first review, PR size, gate wait | PRs waiting longer as output grows |
| Is it safe? | Change failure rate, defects caught before vs. after merge | Failures rising alongside throughput |
| Is the spec useful? | Spec edits after build starts | Frequent rewrites suggest the ceremony isn't paying off |
| Is it learning? | Repeat mistakes after a `/sdlc:learn` rule | Same finding recurring |
| Is it worth the cost? | Tokens per merged change | Cost rising faster than output |

---

## 9. Risks and open questions

| Risk | Mitigation |
| --- | --- |
| The factory becomes the ceremony it's meant to replace | Tracks, and the review after Phase 2. `quick` must stay fast |
| Bash gates are incomplete, since command matching is best effort | Treat them as feedback only; CI is the control |
| Local approvals can be forged by an agent with Bash, by writing the file directly or running `claude -p` | `/sdlc:approve` has no CLI path and refuses unattended sessions, but neither stops a determined agent. Accepted for solo use. On a team, the real approval is the PR review |
| Hook latency in every session | Immediate exit without `.sdlc/`; hooks kept fast and measured |
| Infinite block loops at `SubagentStop` | Retry budget, then escalate |
| Claude Code's plugin surface changes quickly (`experimental.evals`, `experimental.monitors`) | Pin a minimum version; keep logic in the CLI, not in platform features |
| Node isn't guaranteed on every machine | Declare it as a prerequisite and have `/sdlc:init` check for it |
| With 0 required approvals, an agent with merge rights could merge its own PR | Keep merge rights away from agents; raise the count when a second reviewer joins |

**Not yet tested:**

- Hooks inside `isolation: worktree` agents, and whether diff checks see those changes correctly
- Whether an agent can defeat the check by committing out-of-scope work (the check must compare against the branch base, not just the working tree)
- `plugin eval` on this plugin's gates, since no suite exists yet
- Coexistence with Superpowers
- Plugin behavior inside `claude-code-action`

**Weaker evidence:**

- The StrongDM and Fowler/Beck material came through secondary sources
- Competitor summaries come from READMEs, not from using the tools

---

## 10. Decisions

Settled on 2026-10-30:

1. **First audience:** a solo developer or small team on GitHub. Enterprise support comes later.
2. **Plugin name:** `sdlc`, so commands read `/sdlc:next`.
3. **Workflows:** optional, so the plugin works on any plan.
4. **Dogfood repo:** `RCTResources`, a Python 3.12 data pipeline with pytest, ruff, and mypy. It stays local, with no GitHub remote for now.
5. **Project management:** this repo lives on GitHub, with phases as milestones and work as issues.
6. **Branch protection:** this repo is public, because the `shortlst-ai` account can't use branch protection on private repos. `main` requires a PR for everyone, including admins, and blocks force-pushes and deletion. Required approvals are 0, because GitHub doesn't let an author approve their own PR. A second reviewer can raise this later.

### What a local dogfood repo changes

Layer 3 can't run on `RCTResources` without a remote, so Phase 1 splits in two. Real changes exercise the local gates on `RCTResources`. Server enforcement, including the deliberate bypass test, is proven on this repo. The `sdlc-gates` logic should stay callable locally, so both paths run the same check.
