---
description: Reproduce a bug as a failing test. Use at the reproduce stage of the quick track.
---

Spawn a `sdlc:verifier` to write the failing test, giving it the work item folder and the bug report. Use `/sdlc:team` for how.

Confirm the test fails for the reported reason, then commit the test and `evidence/reproduce.md`. It must be committed first, because the test locks once the fix starts. Then use `/sdlc:next`.
