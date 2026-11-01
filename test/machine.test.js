'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const machine = require('../plugins/sdlc/lib/machine');

const { ARTIFACTS, DONE, FLOWS, TRACKS, nextAction, reviewVerdict } = machine;

const CONFIG = {
  tracks: { critical: { paths: ['src/auth/**', 'migrations/**', '*.lock'] }, quick: { max_files: 3 } },
};

function item(track, stage, extra = {}) {
  return { id: '0001-x', track, stage, rework: 0, history: [], ...extra };
}

// Facts for a track where every artifact exists and every gate is approved.
function completeFacts(track) {
  const facts = { artifacts: {}, approvals: {} };
  for (const { stage, gate } of FLOWS[track]) {
    const artifact = ARTIFACTS[stage];
    if (artifact) facts.artifacts[artifact] = `hash-of-${artifact}`;
    if (gate) facts.approvals[stage] = { sha256: `hash-of-${artifact}` };
  }
  return facts;
}

describe('the happy path', () => {
  for (const track of TRACKS) {
    test(`${track} walks every stage in order and ends done`, () => {
      const facts = completeFacts(track);
      let current = item(track, machine.firstStage(track));
      const visited = [current.stage];
      while (current.stage !== DONE) {
        const result = machine.advance(current, facts);
        assert.equal(result.ok, true, `stuck at ${current.stage}`);
        current = result.item;
        visited.push(current.stage);
      }
      assert.deepEqual(visited, [...FLOWS[track].map((step) => step.stage), DONE]);
    });
  }
});

describe('human gates by track', () => {
  const gates = (track) => FLOWS[track].filter((step) => step.gate).map((step) => step.stage);

  test('quick has only the merge gate', () => {
    assert.deepEqual(gates('quick'), ['merge']);
  });

  test('standard has spec and merge gates', () => {
    assert.deepEqual(gates('standard'), ['spec', 'merge']);
  });

  test('only standard lets a clean review stand in for the merge gate', () => {
    const merge = (track) => FLOWS[track].find((step) => step.stage === 'merge').gate;
    assert.equal(merge('quick'), true);
    assert.equal(merge('critical'), true);
    assert.equal(merge('standard'), 'unless-review-passes');
  });

  test('critical has all five gates', () => {
    assert.deepEqual(gates('critical'), ['intent', 'spec', 'plan', 'merge', 'release']);
  });
});

describe('refused moves', () => {
  for (const track of TRACKS) {
    for (const { stage, gate } of FLOWS[track]) {
      const artifact = ARTIFACTS[stage];

      if (artifact) {
        test(`${track}: can't leave ${stage} without ${artifact}`, () => {
          const facts = completeFacts(track);
          facts.artifacts[artifact] = null;
          const result = machine.advance(item(track, stage), facts);
          assert.equal(result.ok, false);
          assert.equal(result.next.action, 'produce');
          assert.equal(result.next.artifact, artifact);
        });
      }

      if (gate) {
        test(`${track}: can't leave ${stage} without approval`, () => {
          const facts = completeFacts(track);
          delete facts.approvals[stage];
          const result = machine.advance(item(track, stage), facts);
          assert.equal(result.ok, false);
          assert.deepEqual(result.next, { action: 'approve', stage, artifact });
        });

        test(`${track}: can't leave ${stage} when ${artifact} changed after approval`, () => {
          const facts = completeFacts(track);
          facts.artifacts[artifact] = 'edited';
          const result = machine.advance(item(track, stage), facts);
          assert.equal(result.ok, false);
          assert.deepEqual(result.next, { action: 'approve', stage, artifact, stale: true });
        });
      }
    }
  }

  test('editing an approved spec reopens its gate from a later stage', () => {
    const facts = completeFacts('standard');
    facts.artifacts['spec.md'] = 'edited';
    const next = machine.nextAction(item('standard', 'build'), facts);
    assert.deepEqual(next, { action: 'approve', stage: 'spec', artifact: 'spec.md', stale: true });
  });

  test('a done item has nothing to do and can\'t advance', () => {
    const done = item('quick', DONE);
    assert.deepEqual(machine.nextAction(done, completeFacts('quick')), { action: 'none' });
    assert.equal(machine.advance(done, completeFacts('quick')).ok, false);
  });
});

describe('rework', () => {
  for (const stage of ['verify', 'review']) {
    test(`${stage} goes back to build and counts the cycle`, () => {
      const result = machine.rework(item('standard', stage), 3);
      assert.equal(result.ok, true);
      assert.equal(result.item.stage, 'build');
      assert.equal(result.item.rework, 1);
    });
  }

  for (const stage of ['spec', 'plan', 'build', 'merge', DONE]) {
    test(`refused from ${stage}`, () => {
      assert.equal(machine.rework(item('standard', stage), 3).ok, false);
    });
  }

  test('refused at the limit, so a person has to decide', () => {
    const result = machine.rework(item('standard', 'verify', { rework: 3 }), 3);
    assert.equal(result.ok, false);
    assert.match(result.reason, /limit/);
  });
});

describe('raising a track', () => {
  test('lowering is refused from every higher track', () => {
    for (const [from, to] of [['standard', 'quick'], ['critical', 'quick'], ['critical', 'standard']]) {
      assert.equal(machine.raiseTrack(item(from, 'build'), to).ok, false, `${from} to ${to}`);
    }
  });

  test('keeps the stage when the new track has it', () => {
    const result = machine.raiseTrack(item('standard', 'build'), 'critical');
    assert.equal(result.item.track, 'critical');
    assert.equal(result.item.stage, 'build');
  });

  test('restarts when the new track lacks the stage', () => {
    const result = machine.raiseTrack(item('quick', 'reproduce'), 'standard');
    assert.equal(result.item.stage, 'spec');
  });

  test('a raised item must backfill gates it skipped', () => {
    const raised = machine.raiseTrack(item('quick', 'build'), 'critical').item;
    const next = machine.nextAction(raised, completeFacts('quick'));
    assert.deepEqual(next, { action: 'produce', stage: 'intent', artifact: 'intent.md' });
  });

  test('a done item can\'t be raised', () => {
    assert.equal(machine.raiseTrack(item('quick', DONE), 'critical').ok, false);
  });
});

describe('classify', () => {
  test('no files means standard', () => {
    assert.equal(machine.classify([], CONFIG), 'standard');
  });

  test('few files means quick', () => {
    assert.equal(machine.classify(['a.py', 'b.py', 'c.py'], CONFIG), 'quick');
  });

  test('more files than the limit means standard', () => {
    assert.equal(machine.classify(['a', 'b', 'c', 'd'], CONFIG), 'standard');
  });

  test('one critical path makes the whole change critical', () => {
    assert.equal(machine.classify(['a.py', 'src/auth/login.py'], CONFIG), 'critical');
  });

  test('path tricks don\'t dodge a critical rule', () => {
    assert.equal(machine.classify(['src/../src/auth/x.py'], CONFIG), 'critical');
    assert.equal(machine.classify(['./migrations/1.sql'], CONFIG), 'critical');
  });
});

describe('globs', () => {
  const cases = [
    ['src/**', 'src/a/b.py', true],
    ['src/**', 'src', false],
    ['**/*.py', 'a.py', true],
    ['**/*.py', 'a/b/c.py', true],
    ['*.lock', 'yarn.lock', true],
    ['*.lock', 'sub/yarn.lock', false],
    ['a?.py', 'ab.py', true],
    ['a?.py', 'a/.py', false],
    ['file.py', 'fileXpy', false],
    ['src/gen/**', 'src/generated/x', false],
  ];
  for (const [glob, file, expected] of cases) {
    test(`${glob} ${expected ? 'matches' : 'skips'} ${file}`, () => {
      assert.equal(machine.matchesAny(file, [glob]), expected);
    });
  }
});

describe('abandoning', () => {
  test('closes an open item from any stage', () => {
    for (const stage of ['spec', 'build', 'merge']) {
      assert.equal(machine.abandon(item('standard', stage)).item.stage, machine.ABANDONED);
    }
  });

  test('a closed item can\'t be abandoned', () => {
    assert.equal(machine.abandon(item('standard', DONE)).ok, false);
    assert.equal(machine.abandon(item('standard', machine.ABANDONED)).ok, false);
  });

  test('an abandoned item has nothing to do', () => {
    const abandoned = item('standard', machine.ABANDONED);
    assert.deepEqual(machine.nextAction(abandoned, completeFacts('standard')), { action: 'none' });
    assert.equal(machine.isValidItem(abandoned), true);
  });
});

describe('isValidItem', () => {
  test('accepts a real item', () => {
    assert.equal(machine.isValidItem(item('standard', 'plan')), true);
    assert.equal(machine.isValidItem(item('standard', DONE)), true);
  });

  test('rejects a stage outside the track', () => {
    assert.equal(machine.isValidItem(item('quick', 'spec')), false);
  });

  test('rejects an unknown track or a bad count', () => {
    assert.equal(machine.isValidItem(item('huge', 'build')), false);
    assert.equal(machine.isValidItem(item('quick', 'build', { rework: '0' })), false);
    assert.equal(machine.isValidItem(item('quick', 'build', { history: undefined })), false);
    assert.equal(machine.isValidItem(null), false);
  });
});

describe('review verdicts', () => {
  const cases = [
    ['**Verdict**: `pass`', 'pass'],
    ['Verdict: pass', 'pass'],
    ['verdict: pass', 'pass'],
    ['**Verdict**: `rework`', 'rework'],
    ['## Findings\n\nThe verdict is fine, but read on.\n\nVerdict: pass\n', 'pass'],
    ['Verdict: pass\nVerdict: rework', null],
    ['Verdict: pass\nverdict: pass', 'pass'],
    ['No verdict here', null],
    ['Verdict: passable', null],
    ['Verdict: maybe', null],
    ['', null],
    [null, null],
  ];
  for (const [text, expected] of cases) {
    test(`${JSON.stringify(text)} reads as ${expected}`, () => {
      assert.equal(reviewVerdict(text), expected);
    });
  }
});

describe('the standard merge gate', () => {
  const REVIEW = 'evidence/review.md';
  const artifacts = Object.fromEntries(Object.values(ARTIFACTS).map((file) => [file, 'hash']));
  const atMerge = (track) => ({ id: '0001-a', track, stage: 'merge', rework: 0, history: [] });
  const facts = (verdict, approvals = {}) => ({
    artifacts,
    approvals: { spec: { sha256: 'hash' }, intent: { sha256: 'hash' }, plan: { sha256: 'hash' }, ...approvals },
    verdict,
  });

  test('a clean review needs no second approval', () => {
    assert.deepEqual(nextAction(atMerge('standard'), facts('pass')), { action: 'advance', to: DONE });
  });

  for (const verdict of ['rework', null, undefined]) {
    test(`a ${verdict} verdict still needs a person`, () => {
      const next = nextAction(atMerge('standard'), facts(verdict));
      assert.deepEqual(next, { action: 'approve', stage: 'merge', artifact: REVIEW });
    });
  }

  test('a person can still sign off a review that didn\'t pass', () => {
    const approvals = { merge: { sha256: 'hash' } };
    assert.equal(nextAction(atMerge('standard'), facts('rework', approvals)).action, 'advance');
  });

  for (const track of ['quick', 'critical']) {
    test(`${track} needs a person even after a clean review`, () => {
      assert.equal(nextAction(atMerge(track), facts('pass')).action, 'approve');
    });
  }
});
