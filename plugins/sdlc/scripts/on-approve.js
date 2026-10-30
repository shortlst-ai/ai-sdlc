#!/usr/bin/env node
'use strict';

// UserPromptExpansion handler for /sdlc:approve. Runs outside the model, which
// is what makes the approval a human one.

const fs = require('node:fs');

const { approve } = require('../lib/approve');
const { SdlcError } = require('../lib/workspace');

function block(reason) {
  console.log(JSON.stringify({ decision: 'block', reason: `Not approved: ${reason}` }));
}

function allow(context) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptExpansion', additionalContext: context },
    }),
  );
}

function main() {
  // A person isn't at an unattended session, so this stops an agent reaching
  // approval by starting `claude -p`. It's a guard against wandering into this
  // path, not a security boundary. That boundary is the CI check. Anything but
  // an explicit 0 is allowed, so a missing variable can't lock people out.
  if (process.env.CLAUDE_CODE_SESSION_ATTENDED === '0') {
    block('approvals need a person, and this session is unattended.');
    return;
  }
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const query = (input.command_args ?? '').trim().split(/\s+/)[0] || undefined;
  const record = approve({ cwd: input.cwd, query });
  allow(
    `Approval recorded: ${record.id} ${record.stage}, ${record.artifact} ` +
      `(sha256 ${record.sha256.slice(0, 12)}), by ${record.approver.name}.`,
  );
}

try {
  main();
} catch (error) {
  if (!(error instanceof SdlcError)) throw error;
  block(`${error.message}.`);
}
