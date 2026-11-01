---
description: Prove the current work item works. Use at the verify stage.
---

Spawn a `sdlc:verifier` to write acceptance tests for the spec, giving it the work item folder. Use `/sdlc:team` for how.

Commit, then run `sdlc verify`. It only vouches for committed code. It runs the tests and writes the evidence, so never write `evidence/verify.md` yourself.

If it fails, run `sdlc rework --reason "<what failed>"`, then use `/sdlc:next`.

If it passes, commit the evidence and use `/sdlc:next`.
