---
description: Start a work item in the current worktree. Use when asked to start a feature, change, or fix through the factory.
argument-hint: "<slug> [files]"
---

Start a work item for: $ARGUMENTS

1. Run `git branch --show-current`. Each work item needs its own worktree, so if this is the default branch, stop and tell the person to start one:

   ```bash
   claude --worktree <slug>
   ```

2. If the session start context asked for it, run `sdlc setup`.
3. Run `sdlc new <slug>`. For a small fix, pass the files with `--files a,b`, so the track can be worked out. Don't pick a track yourself. You may only raise one with `--track`.
4. Commit the new item, then continue with `/sdlc:next`.
