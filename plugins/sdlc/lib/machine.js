'use strict';

// The rules of the factory. Pure functions only: every fact about the disk is
// passed in, so each transition can be tested without touching the filesystem.

const path = require('node:path');

// Ordered lowest to highest. A track can only move to the right.
const TRACKS = ['quick', 'standard', 'critical'];

const DONE = 'done';

const ARTIFACTS = {
  reproduce: 'evidence/reproduce.md',
  intent: 'intent.md',
  spec: 'spec.md',
  plan: 'plan.md',
  verify: 'evidence/verify.md',
  review: 'evidence/review.md',
  // The merge gate approves the review result, so it binds to the same file.
  merge: 'evidence/review.md',
  release: 'evidence/release.md',
};

// `gate: true` means a person must approve before the stage can be left.
const FLOWS = {
  quick: [
    { stage: 'reproduce' },
    { stage: 'build' },
    { stage: 'verify' },
    { stage: 'review' },
    { stage: 'merge', gate: true },
  ],
  standard: [
    { stage: 'spec', gate: true },
    { stage: 'plan' },
    { stage: 'build' },
    { stage: 'verify' },
    { stage: 'review' },
    { stage: 'merge', gate: true },
  ],
  critical: [
    { stage: 'intent', gate: true },
    { stage: 'spec', gate: true },
    { stage: 'plan', gate: true },
    { stage: 'build' },
    { stage: 'verify' },
    { stage: 'review' },
    { stage: 'merge', gate: true },
    { stage: 'release', gate: true },
  ],
};

const REWORK_FROM = ['verify', 'review'];

function trackRank(track) {
  return TRACKS.indexOf(track);
}

function firstStage(track) {
  return FLOWS[track][0].stage;
}

function stageIndex(track, stage) {
  return FLOWS[track].findIndex((step) => step.stage === stage);
}

function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      i += 1;
      if (glob[i + 1] === '/') {
        i += 1;
        source += '(?:.*/)?';
      } else {
        source += '.*';
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

// Normalizing first stops `src/../src/auth/x` from slipping past `src/auth/**`.
function matchesAny(file, globs) {
  const normalized = path.posix.normalize(file);
  return globs.some((glob) => globToRegExp(glob).test(normalized));
}

// Decides the track from the files a change touches. With no files there is
// nothing to classify on, so the change gets the normal process.
function classify(files, config) {
  if (files.length === 0) return 'standard';
  if (files.some((file) => matchesAny(file, config.tracks.critical.paths))) return 'critical';
  if (files.length <= config.tracks.quick.max_files) return 'quick';
  return 'standard';
}

// `facts.artifacts` maps artifact paths to their hash, or null when missing.
// `facts.approvals` maps stage names to their recorded approval, if any.
function nextAction(item, facts) {
  if (item.stage === DONE) return { action: 'none' };

  const flow = FLOWS[item.track];
  const current = stageIndex(item.track, item.stage);

  // Earlier stages are rechecked too, so editing an approved artifact reopens
  // its gate even after the work has moved on.
  for (const { stage, gate } of flow.slice(0, current + 1)) {
    const artifact = ARTIFACTS[stage];
    if (!artifact) continue;
    const hash = facts.artifacts[artifact] ?? null;
    if (hash === null) return { action: 'produce', stage, artifact };
    if (gate) {
      const approval = facts.approvals[stage];
      if (!approval) return { action: 'approve', stage, artifact };
      if (approval.sha256 !== hash) return { action: 'approve', stage, artifact, stale: true };
    }
  }

  const following = flow[current + 1];
  return { action: 'advance', to: following ? following.stage : DONE };
}

function describeNext(next) {
  switch (next.action) {
    case 'produce':
      return `write ${next.artifact} for the ${next.stage} stage`;
    case 'approve':
      return next.stale
        ? `${next.artifact} changed after approval, so ${next.stage} needs approving again`
        : `a person must approve ${next.stage}`;
    case 'advance':
      return `advance to ${next.to}`;
    default:
      return 'nothing, this item is done';
  }
}

function advance(item, facts) {
  const next = nextAction(item, facts);
  if (next.action !== 'advance') return { ok: false, next };
  return { ok: true, item: { ...item, stage: next.to } };
}

function rework(item, limit) {
  if (!REWORK_FROM.includes(item.stage)) {
    return { ok: false, reason: `can't rework from '${item.stage}', only from ${REWORK_FROM.join(' or ')}` };
  }
  if (item.rework >= limit) {
    return { ok: false, reason: `rework limit of ${limit} reached, so this needs a person to decide` };
  }
  return { ok: true, item: { ...item, stage: 'build', rework: item.rework + 1 } };
}

// Stages the new track doesn't have restart at its first stage, so a change
// raised off the quick track backfills the artifacts it skipped.
function raiseTrack(item, track) {
  if (item.stage === DONE) return { ok: false, reason: `${item.id} is already done` };
  if (trackRank(track) < trackRank(item.track)) {
    return { ok: false, reason: `can't lower the track from '${item.track}' to '${track}'` };
  }
  const stage = stageIndex(track, item.stage) === -1 ? firstStage(track) : item.stage;
  return { ok: true, item: { ...item, track, stage } };
}

function isValidItem(item) {
  if (!item || !TRACKS.includes(item.track)) return false;
  if (!Number.isInteger(item.rework) || !Array.isArray(item.history)) return false;
  return item.stage === DONE || stageIndex(item.track, item.stage) !== -1;
}

module.exports = {
  ARTIFACTS,
  DONE,
  FLOWS,
  TRACKS,
  advance,
  classify,
  describeNext,
  firstStage,
  isValidItem,
  matchesAny,
  nextAction,
  raiseTrack,
  rework,
  trackRank,
};
