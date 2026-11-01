#!/usr/bin/env node
'use strict';

// UserPromptExpansion handler for /sdlc:approve and /sdlc:abandon. Runs outside
// the model, which is what makes these decisions human ones.

const fs = require('node:fs');

const { abandon, approve, approveAll } = require('../lib/approve');
const { SdlcError } = require('../lib/workspace');

function block(reason) {
  console.log(JSON.stringify({ decision: 'block', reason: `Not recorded: ${reason}` }));
}

function allow(context) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptExpansion', additionalContext: context },
    }),
  );
}

const ITEM_ID = /^\d+(-[a-z0-9-]+)?$/;

function recorded(record) {
  return (
    `Approval recorded: ${record.id} ${record.stage}, ${record.artifact} ` +
    `(sha256 ${record.sha256.slice(0, 12)}), by ${record.approver.name}.`
  );
}

function runApprove(input, args) {
  const records =
    args[0] === 'all' ? approveAll({ cwd: input.cwd }) : [approve({ cwd: input.cwd, query: args[0] })];
  allow(records.map(recorded).join('\n'));
}

function runAbandon(input, args) {
  const query = ITEM_ID.test(args[0] ?? '') ? args.shift() : undefined;
  const record = abandon({ cwd: input.cwd, query, reason: args.join(' ') });
  allow(`Abandon recorded: ${record.id}, because ${record.reason}.`);
}

const COMMANDS = { approve: runApprove, abandon: runAbandon };

function main() {
  // A person isn't at an unattended session, so this stops an agent reaching
  // these commands by starting `claude -p`. It's a guard against wandering into
  // this path, not a security boundary. That boundary is the CI check. Anything
  // but an explicit 0 is allowed, so a missing variable can't lock people out.
  if (process.env.CLAUDE_CODE_SESSION_ATTENDED === '0') {
    block('this needs a person, and this session is unattended.');
    return;
  }
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const args = (input.command_args ?? '').trim().split(/\s+/).filter(Boolean);
  COMMANDS[process.argv[2]](input, args);
}

try {
  main();
} catch (error) {
  if (!(error instanceof SdlcError)) throw error;
  block(`${error.message}.`);
}
