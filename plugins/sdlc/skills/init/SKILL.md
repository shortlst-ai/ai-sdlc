---
description: Set up the software factory in a repo. Use when asked to adopt or initialize the factory.
disable-model-invocation: true
---

Set up the factory in this repo.

1. Read the repo to find its setup, test, and format commands. Check CLAUDE.md, the README, and the build files. A worktree has no gitignored files, so the setup command must build a fresh environment from scratch.
2. Show the commands you found, and ask which paths should get the critical track or be protected.
3. Run `sdlc init` with what was agreed:

   ```bash
   sdlc init --setup "<cmd>" --verify "<cmd>" --format "<cmd with {file}>" --critical "a/**,b/**" --protected "gen/**"
   ```

4. Tell the person to review and commit `.sdlc/`, `.claude/settings.json`, and `.gitignore` to the base branch. Worktrees can't see the factory until that's done.
5. Tell them to start each change with `claude --worktree <slug>` from a terminal. That only works in a folder Claude has already trusted, so run plain `claude` here once if it hasn't been.

Don't edit `.sdlc/config.json` yourself. After init, only people change it.
