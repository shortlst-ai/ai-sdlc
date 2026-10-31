'use strict';

// The server-side check. Everything before this gives feedback to an agent that's
// trying to follow the process. This is the part that doesn't take its word for
// anything: it recomputes each gate from the files, measures the diff from the
// pull request's real base, and reads the rules from that base, so a change can't
// loosen the rules it's being judged by.

const { execFileSync } = require('node:child_process');

const { reviewBuild } = require('./check');
const machine = require('./machine');
const workspace = require('./workspace');

const { ARTIFACTS, FLOWS, classify, isOpen, trackRank } = machine;
const { SdlcError } = workspace;

function git(root, args) {
  try {
    const options = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    return execFileSync('git', args, options).trim();
  } catch {
    return null;
  }
}

function configAt(root, ref) {
  const text = git(root, ['show', `${ref}:.sdlc/config.json`]);
  return text === null ? workspace.loadConfig(root) : workspace.parseConfig(text);
}

function touchedItems(root, base) {
  const paths = (git(root, ['diff', '--name-only', base, '--', '.sdlc/work']) ?? '').split('\n');
  const ids = paths.map((file) => file.split('/')[2]).filter(Boolean);
  return [...new Set(ids)].filter((id) => workspace.listIds(root).includes(id));
}

// Walks every stage of the track rather than trusting where state.json says the
// item is, so editing the stage can't skip a gate.
function auditGates(root, item) {
  const problems = [];
  const facts = workspace.readFacts(root, item);
  for (const { stage, gate } of FLOWS[item.track]) {
    const artifact = ARTIFACTS[stage];
    if (!artifact) continue;
    const hash = facts.artifacts[artifact] ?? null;
    if (hash === null) {
      problems.push(`${stage}: ${artifact} is missing or out of date`);
    } else if (gate) {
      const approval = facts.approvals[stage];
      if (!approval) problems.push(`${stage}: no approval`);
      else if (approval.sha256 !== hash) problems.push(`${stage}: ${artifact} changed after approval`);
      else if (!approval.approver?.email) problems.push(`${stage}: the approval names nobody`);
    }
  }
  return problems;
}

function auditItem(root, id, base, config) {
  const loaded = workspace.loadItem(root, id);
  if (!isOpen(loaded) && loaded.stage === machine.ABANDONED) return [`${id}: it was abandoned`];
  const lastStage = FLOWS[loaded.track].at(-1).stage;
  const finished = loaded.stage === machine.DONE || loaded.stage === lastStage;
  const problems = finished ? [] : [`it's at ${loaded.stage}, not finished`];

  // The real base replaces the one in state.json, which a change could edit.
  const item = { ...loaded, base };
  const changed = workspace.changedFiles(root, base);
  if (changed.length > 0 && trackRank(classify(changed, config)) > trackRank(item.track)) {
    problems.push(`its files need the ${classify(changed, config)} track, not ${item.track}`);
  }
  problems.push(...reviewBuild(root, item, config).problems, ...auditGates(root, item));
  return problems.map((problem) => `${id}: ${problem}`);
}

function runGates(cwd, ref) {
  const root = workspace.findRoot(cwd);
  if (!root) return { factory: false, items: [], problems: [] };
  const base = git(root, ['merge-base', ref, 'HEAD']);
  if (!base) throw new SdlcError(`can't find a merge base with ${ref}: is the history fetched?`);
  const config = configAt(root, base);
  const items = touchedItems(root, base);
  const problems = items.flatMap((id) => auditItem(root, id, base, config));
  if (items.length === 0 && workspace.changedFiles(root, base).length > 0) {
    problems.push('this change has no work item');
  }
  return { factory: true, items, problems };
}

module.exports = { runGates };
