---
max_turns: 20
timeout_seconds: 240
allowed_tools: [Read, Glob, Grep, Skill, Agent]
append_system_prompt: "In this environment the sdlc command is at ./.tools/sdlc, so run it as ./.tools/sdlc. It is the same program. git is not available here, so skip git commands. You are on the branch worktree-feature, and a commit that fails is fine."
---

/sdlc:new add-subtract add a subtract function to calc.py
