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
3. Run `sdlc new <slug>`. Every change takes the same path. If you know it touches a critical path, pass the files with `--files a,b`, so the extra sign-offs apply.
4. Commit the new item.
5. Use `/sdlc:next` straight away, in this same turn. Starting the item isn't a stopping point, and the person shouldn't have to prompt you. Pass on what they asked for, because the spec writer can't see this conversation.
