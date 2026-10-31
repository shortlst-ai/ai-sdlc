'use strict';

// Decisions only a person can make. These are reached only through the
// UserPromptExpansion hook, and the CLI has no such commands on purpose: the model
// can run the CLI, and it must not be able to approve or drop its own work.

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

function factoryRoot(cwd) {
  const root = workspace.findRoot(cwd);
  if (!root) throw new SdlcError('this repo does not use the factory: run sdlc init');
  return root;
}

// What's waiting on a person across the repo, for someone with no item here.
function waitingList(root) {
  return workspace.openEverywhere(root).flatMap(({ root: dir, item }) => {
    const next = machine.nextAction(item, workspace.readFacts(dir, item));
    return next.action === 'approve' ? [`${item.id} (${next.stage})`] : [];
  });
}

function target(root, query) {
  if (query) return workspace.locateItem(root, query);
  const hasOwn = workspace.ownItems(root).some(machine.isOpen);
  const waiting = hasOwn ? [] : waitingList(root);
  if (waiting.length > 0) throw new SdlcError(`name one, waiting on you: ${waiting.join(', ')}`);
  return { root, item: workspace.activeItem(root) };
}

// Approves only what the state machine is waiting on, so a stale request can't
// sign off on the wrong stage. The hash binds the approval to these exact bytes.
// The item can live in any worktree, because a person approves from one place.
function approve({ cwd, query }) {
  const { root, item } = target(factoryRoot(cwd), query);
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

// The item stays on disk with its reason, so abandoning leaves an audit trail.
function abandon({ cwd, query, reason }) {
  if (!reason) throw new SdlcError('give a reason: /sdlc:abandon [id] <reason>');
  const { root, item } = target(factoryRoot(cwd), query);
  const result = machine.abandon(item);
  if (!result.ok) throw new SdlcError(result.reason);
  const event = { at: new Date().toISOString(), abandoned_from: item.stage, reason, by: approver(root) };
  workspace.saveItem(root, { ...result.item, history: [...item.history, event] });
  return { id: item.id, reason };
}

module.exports = { abandon, approve };
