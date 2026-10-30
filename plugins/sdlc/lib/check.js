'use strict';

// Compares what a build really changed against what the plan allowed. It reads
// the diff rather than watching edits, because Bash can reach around any edit
// hook, and a diff can't be dodged by committing the work.

const { classify, matchesAny, raiseTrack, trackRank } = require('./machine');
const workspace = require('./workspace');

const SCOPE_BLOCK = /^```scope[^\n]*\n([\s\S]*?)^```/gm;

// plan.md lists what a build may touch in fenced ```scope blocks, one glob a line.
function parseScope(text) {
  const globs = [];
  for (const [, body] of text.matchAll(SCOPE_BLOCK)) {
    globs.push(...body.split('\n').map((line) => line.trim()).filter(Boolean));
  }
  return globs;
}

function scopeFor(item, plan) {
  return item.track === 'quick' ? (item.files ?? []) : parseScope(plan ?? '');
}

// Test files are always in scope: the plan names the code, and the verifier adds
// tests it couldn't have listed. The quick track's test lock is checked separately.
function outOfScope(changed, scope, testGlobs) {
  return changed.filter((file) => !matchesAny(file, scope) && !matchesAny(file, testGlobs));
}

function commitAfterReproduce(item) {
  return item.history.find((event) => event.from === 'reproduce')?.commit ?? null;
}

// Returns every reason this build can't leave `build`, with the item on the track
// its real files call for.
function reviewBuild(root, item, config) {
  const problems = [];
  const changed = workspace.changedFiles(root, item.base);
  // With nothing changed there's nothing to classify, and classify's default for
  // no files would wrongly raise a quick item.
  const needed = changed.length > 0 ? classify(changed, config) : item.track;
  const raised = trackRank(needed) > trackRank(item.track) ? raiseTrack(item, needed).item : item;

  const scope = scopeFor(raised, workspace.readArtifact(root, raised, 'plan.md'));
  if (scope.length === 0 && item.base) {
    problems.push('plan.md has no ```scope block saying which files this change may touch');
  } else {
    const outside = outOfScope(changed, scope, config.tests);
    if (outside.length > 0) problems.push(`outside the plan's scope: ${outside.join(', ')}`);
  }

  const locked = commitAfterReproduce(raised);
  if (raised.track === 'quick' && locked) {
    const edited = workspace.changedFiles(root, locked).filter((file) => matchesAny(file, config.tests));
    if (edited.length > 0) problems.push(`tests changed during the fix: ${edited.join(', ')}`);
  }
  return { item: raised, problems };
}

module.exports = { outOfScope, parseScope, reviewBuild };
