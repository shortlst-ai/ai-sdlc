'use strict';

// Compares what a build really changed against what the spec allowed. It reads
// the diff rather than watching edits, because Bash can reach around any edit
// hook, and a diff can't be dodged by committing the work.

const { classify, isOpen, matchesAny, raiseTrack, reviewVerdict, trackRank } = require('./machine');
const workspace = require('./workspace');

const SCOPE_BLOCK = /^```scope[^\n]*\n([\s\S]*?)^```/gm;

// spec.md lists each slice under a heading such as `### S1: Parse the file`, with
// what it may touch in a fenced ```scope block, one glob a line. 
function parseScope(text) {
  const globs = [];
  for (const [, body] of text.matchAll(SCOPE_BLOCK)) {
    globs.push(...body.split('\n').map((line) => line.trim()).filter(Boolean));
  }
  return globs;
}

// A spec with no slice headings is one slice.
function parseSlices(text) {
  const ids = [...(text ?? '').matchAll(/^#{2,4}\s+(S\d+)\b/gm)].map((match) => match[1]);
  return ids.length > 0 ? [...new Set(ids)] : ['S1'];
}

// Test files are always in scope: the spec names the code, and the verifier adds
// tests it couldn't have listed.
function outOfScope(changed, scope, testGlobs) {
  return changed.filter((file) => !matchesAny(file, scope) && !matchesAny(file, testGlobs));
}

// Returns every reason this build can't leave `build`, with the item on the track
// its real files call for.
function reviewBuild(root, item, config) {
  const problems = [];
  const changed = workspace.changedFiles(root, item.base);
  const needed = classify(changed, config);
  const shouldRaise = isOpen(item) && trackRank(needed) > trackRank(item.track);
  const raised = shouldRaise ? raiseTrack(item, needed).item : item;

  const scope = parseScope(workspace.readArtifact(root, raised, 'spec.md') ?? '');
  if (scope.length === 0 && item.base) {
    problems.push('spec.md has no ```scope block saying which files this change may touch');
  } else {
    const outside = outOfScope(changed, scope, config.tests);
    if (outside.length > 0) problems.push(`outside the spec's scope: ${outside.join(', ')}`);
  }
  return { item: raised, problems };
}

// Each slice needs its own passing review before the build can finish, so a mistake
// in one slice is caught before the next builds on it.
function reviewSlices(root, item) {
  return parseSlices(workspace.readArtifact(root, item, 'spec.md')).flatMap((id) => {
    const report = workspace.readArtifact(root, item, `evidence/reviews/${id}.md`);
    if (report === null) return [`slice ${id} has no review`];
    return reviewVerdict(report) === 'pass' ? [] : [`slice ${id} didn't pass its review`];
  });
}

// Added and deleted lines outside the factory's own files.
function changeSize(root, item) {
  return workspace.changedLines(root, item.base);
}

module.exports = { changeSize, outOfScope, parseScope, parseSlices, reviewBuild, reviewSlices };
