'use strict';

// Records a human approval. This is reached only through the UserPromptExpansion
// hook, and the CLI has no approve command on purpose: the model can run the CLI,
// and it must not be able to approve its own work.

const { execFileSync } = require('node:child_process');

const machine = require('./machine');
const workspace = require('./workspace');

const { SdlcError } = workspace;

function gitConfig(root, key) {
  try {
    const options = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    return execFileSync('git', ['config', key], options).trim();
  } catch {
    return '';
  }
}

// An approval has to name a person, so a machine with no identity can't record one.
function approver(root) {
  const name = gitConfig(root, 'user.name');
  const email = gitConfig(root, 'user.email');
  if (!name || !email) {
    throw new SdlcError('set git user.name and user.email first, so the approval names you');
  }
  return { name, email };
}

// Approves only what the state machine is waiting on, so a stale request can't
// sign off on the wrong stage. The hash binds the approval to these exact bytes.
function approve({ cwd, query }) {
  const root = workspace.findRoot(cwd);
  if (!root) throw new SdlcError('this repo does not use the factory: run sdlc init');
  const item = workspace.activeItem(root, query);
  const facts = workspace.readFacts(root, item);
  const next = machine.nextAction(item, facts);
  if (next.action !== 'approve') {
    throw new SdlcError(`${item.id} isn't waiting on an approval: ${machine.describeNext(next)}`);
  }
  const record = {
    stage: next.stage,
    artifact: next.artifact,
    sha256: facts.artifacts[next.artifact],
    approver: approver(root),
    at: new Date().toISOString(),
  };
  workspace.saveApproval(root, item, record);
  return { id: item.id, ...record };
}

module.exports = { approve };
