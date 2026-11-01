'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');

const { outOfScope, parseScope, parseSlices } = require('../plugins/sdlc/lib/check');

const PLUGIN = path.join(__dirname, '..', 'plugins', 'sdlc');
const CLI = path.join(PLUGIN, 'bin', 'sdlc');
const HOOK = path.join(PLUGIN, 'scripts', 'hook.js');
const ID = '0001-feature';

function env() {
  return { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
}

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, env: env(), stdio: 'ignore' });
}

function sdlc(cwd, ...args) {
  return spawnSync(CLI, args, { cwd, encoding: 'utf8', env: env() });
}

function touch(cwd, file, content = 'x\n') {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
}

function commitAll(cwd, message = 'work') {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
}

function repo(t, verify) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-check-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  assert.equal(sdlc(dir, 'init').status, 0);
  const file = path.join(dir, '.sdlc', 'config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.commands.verify = verify ?? 'true';
  config.tracks.critical.paths = ['src/auth/**'];
  fs.writeFileSync(file, JSON.stringify(config));
  commitAll(dir, 'first');
  return dir;
}

function itemFile(cwd, ...parts) {
  return path.join(cwd, '.sdlc', 'work', ID, ...parts);
}

function state(cwd) {
  return JSON.parse(fs.readFileSync(itemFile(cwd, 'state.json'), 'utf8'));
}

const SPEC = '# Spec\n\n### S1: The API\n\n```scope name=api\nsrc/api/**\n```\n';

function approve(cwd, stage, artifact, content) {
  touch(cwd, `.sdlc/work/${ID}/${artifact}`, content);
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  touch(cwd, `.sdlc/work/${ID}/approvals/${stage}.json`, JSON.stringify({ sha256 }));
}

function passReview(cwd, slice = 'S1', report = 'Verdict: pass\n') {
  touch(cwd, `.sdlc/work/${ID}/evidence/reviews/${slice}.md`, report);
}

// An item at build, with an approved spec that allows src/api/.
function atBuild(t, verify, spec = SPEC) {
  const cwd = repo(t, verify);
  assert.equal(sdlc(cwd, 'new', 'feature').status, 0);
  approve(cwd, 'intent', 'intent.md', 'intent');
  assert.equal(sdlc(cwd, 'advance').status, 0);
  approve(cwd, 'spec', 'spec.md', spec);
  assert.equal(sdlc(cwd, 'advance').status, 0);
  return cwd;
}

function stop(cwd, extra = {}) {
  const input = { cwd, agent_type: 'sdlc:builder', agent_id: 'a1', ...extra };
  return spawnSync('node', [HOOK, 'subagent-stop'], { input: JSON.stringify(input), encoding: 'utf8', env: env() });
}

describe('parseScope', () => {
  test('reads globs from every scope block', () => {
    const text = '```scope name=a\nsrc/a/**\nsrc/b.py\n```\ntext\n```scope\n  src/c/**\n\n```\n';
    assert.deepEqual(parseScope(text), ['src/a/**', 'src/b.py', 'src/c/**']);
  });

  test('ignores other code blocks', () => {
    assert.deepEqual(parseScope('```python\nsrc/x.py\n```\n'), []);
  });

  test('no blocks means no scope', () => {
    assert.deepEqual(parseScope('# Plan'), []);
  });
});

describe('outOfScope', () => {
  test('lists what the spec didn\'t allow', () => {
    assert.deepEqual(outOfScope(['src/a.py', 'src/b.py'], ['src/a.py'], []), ['src/b.py']);
  });

  test('test files are always in scope', () => {
    assert.deepEqual(outOfScope(['tests/test_a.py'], ['src/**'], ['tests/**']), []);
  });
});

describe('the scope check', () => {
  test('passes when changes match the spec', (t) => {
    const cwd = atBuild(t);
    touch(cwd, 'src/api/a.py');
    assert.equal(sdlc(cwd, 'check').status, 0);
    passReview(cwd);
    assert.equal(sdlc(cwd, 'advance').status, 0);
  });

  test('catches uncommitted, untracked work outside the spec', (t) => {
    const cwd = atBuild(t);
    touch(cwd, 'src/other/a.py');
    const result = sdlc(cwd, 'check');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /outside the spec's scope: src\/other\/a\.py/);
  });

  test('catches work that was committed', (t) => {
    const cwd = atBuild(t);
    touch(cwd, 'src/other/a.py');
    commitAll(cwd);
    assert.match(sdlc(cwd, 'check').stderr, /outside the spec's scope: src\/other\/a\.py/);
  });

  test('catches a deleted file', (t) => {
    const cwd = repo(t);
    touch(cwd, 'src/other/a.py');
    commitAll(cwd);
    sdlc(cwd, 'new', 'feature');
    touch(cwd, `.sdlc/work/${ID}/spec.md`, 'spec');
    touch(cwd, `.sdlc/work/${ID}/spec.md`, SPEC);
    const sha256 = crypto.createHash('sha256').update('spec').digest('hex');
    touch(cwd, `.sdlc/work/${ID}/approvals/spec.json`, JSON.stringify({ sha256 }));
    sdlc(cwd, 'advance');
    sdlc(cwd, 'advance');
    fs.rmSync(path.join(cwd, 'src/other/a.py'));
    assert.match(sdlc(cwd, 'check').stderr, /outside the spec's scope/);
  });

  test('a build can\'t advance outside its scope', (t) => {
    const cwd = atBuild(t);
    touch(cwd, 'src/other/a.py');
    const result = sdlc(cwd, 'advance');
    assert.equal(result.status, 1);
    assert.equal(state(cwd).stage, 'build');
  });

  test('a spec with no scope block can\'t leave build', (t) => {
    const cwd = atBuild(t, 'true', '# Spec with no scope');
    assert.match(sdlc(cwd, 'advance').stderr, /no ```scope block/);
  });

  test('factory files never count as out of scope', (t) => {
    const cwd = atBuild(t);
    touch(cwd, `.sdlc/work/${ID}/notes.md`);
    assert.equal(sdlc(cwd, 'check').status, 0);
  });
});

describe('reclassifying from the real diff', () => {
  test('files that touch a critical path raise the track', (t) => {
    const cwd = atBuild(t, 'true', '```scope\nsrc/**\n```\n');
    touch(cwd, 'src/auth/login.py');
    passReview(cwd);
    const result = sdlc(cwd, 'advance');
    assert.match(result.stdout, /track was raised/);
    assert.equal(state(cwd).track, 'critical');
    assert.equal(state(cwd).stage, 'verify');
  });

  test('an ordinary change stays on the ordinary path', (t) => {
    const cwd = atBuild(t);
    touch(cwd, 'src/api/a.py');
    passReview(cwd);
    assert.equal(sdlc(cwd, 'advance').status, 0);
    assert.equal(state(cwd).track, 'standard');
  });
});

describe('slices', () => {
  const TWO = '### S1: First\n\n```scope\nsrc/api/**\n```\n\n### S2: Second\n\n```scope\nsrc/web/**\n```\n';

  test('reads the slices from the spec', () => {
    assert.deepEqual(parseSlices(TWO), ['S1', 'S2']);
  });

  test('a heading level doesn\'t matter, and a repeat counts once', () => {
    assert.deepEqual(parseSlices('## S1: a\n#### S2 b\n### S1: again\n'), ['S1', 'S2']);
  });

  test('a spec with no slice headings is one slice', () => {
    assert.deepEqual(parseSlices('```scope\nsrc/**\n```\n'), ['S1']);
    assert.deepEqual(parseSlices(null), ['S1']);
  });

  test('a mention of a slice in the text isn\'t a slice', () => {
    assert.deepEqual(parseSlices('### S1: a\n\nThis depends on S2 later.\n'), ['S1']);
  });

  test('a build can\'t finish until every slice has passed review', (t) => {
    const cwd = atBuild(t, 'true', TWO);
    touch(cwd, 'src/api/a.py');
    assert.match(sdlc(cwd, 'advance').stderr, /slice S1 has no review; slice S2 has no review/);

    passReview(cwd, 'S1');
    assert.match(sdlc(cwd, 'advance').stderr, /slice S2 has no review/);

    passReview(cwd, 'S2', 'Verdict: rework\n');
    assert.match(sdlc(cwd, 'advance').stderr, /slice S2 didn't pass its review/);
    assert.equal(state(cwd).stage, 'build');

    passReview(cwd, 'S2');
    assert.equal(sdlc(cwd, 'advance').status, 0);
    assert.equal(state(cwd).stage, 'verify');
  });

  test('sending a change back throws away its slice reviews', (t) => {
    const cwd = atBuild(t);
    touch(cwd, 'src/api/a.py');
    passReview(cwd);
    assert.equal(sdlc(cwd, 'advance').status, 0);
    assert.equal(sdlc(cwd, 'rework', '--reason', 'tests fail').status, 0);
    assert.equal(fs.existsSync(itemFile(cwd, 'evidence', 'reviews', 'S1.md')), false);
    assert.match(sdlc(cwd, 'advance').stderr, /slice S1 has no review/);
  });

  test('a large change gets a warning, not a refusal', (t) => {
    const cwd = atBuild(t);
    touch(cwd, 'src/api/a.py', 'line\n'.repeat(700));
    commitAll(cwd);
    const result = sdlc(cwd, 'check');
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Warning: 700 changed lines/);
  });

  test('a small change gets no warning', (t) => {
    const cwd = atBuild(t);
    touch(cwd, 'src/api/a.py');
    commitAll(cwd);
    assert.doesNotMatch(sdlc(cwd, 'check').stdout, /Warning/);
  });

  test('an amended spec reopens its gate, even in the middle of a build', (t) => {
    const cwd = atBuild(t);
    touch(cwd, `.sdlc/work/${ID}/spec.md`, `${SPEC}\nOne more thing.\n`);
    const [item] = JSON.parse(sdlc(cwd, 'status', '--json').stdout).items;
    assert.deepEqual(item.next, { action: 'approve', stage: 'spec', artifact: 'spec.md', stale: true });
    touch(cwd, 'src/api/a.py');
    passReview(cwd);
    assert.match(sdlc(cwd, 'advance').stderr, /a person must type \/sdlc:approve again/);
  });
});

describe('sdlc verify', () => {
  function atVerify(t, command) {
    const cwd = atBuild(t, command);
    touch(cwd, 'src/api/a.py');
    passReview(cwd);
    assert.equal(sdlc(cwd, 'advance').status, 0);
    return cwd;
  }

  test('writes evidence from the real run', (t) => {
    const cwd = atVerify(t, 'echo all good');
    assert.equal(sdlc(cwd, 'verify').status, 0);
    const evidence = fs.readFileSync(itemFile(cwd, 'evidence', 'verify.md'), 'utf8');
    assert.match(evidence, /^command: echo all good$/m);
    assert.match(evidence, /^code: [0-9a-f]{64}$/m);
    assert.match(evidence, /all good/);
    assert.equal(sdlc(cwd, 'advance').status, 0);
  });

  test('a failed run writes no pass', (t) => {
    const cwd = atVerify(t, 'exit 1');
    assert.equal(sdlc(cwd, 'verify').status, 1);
    assert.equal(fs.existsSync(itemFile(cwd, 'evidence', 'verify.md')), false);
  });

  test('a failure replaces an earlier pass', (t) => {
    const cwd = atVerify(t, 'test ! -f broken.flag');
    assert.equal(sdlc(cwd, 'verify').status, 0);
    fs.writeFileSync(path.join(cwd, '.git', 'info', 'exclude'), 'broken.flag\n');
    touch(cwd, 'broken.flag');
    const result = sdlc(cwd, 'verify');
    assert.equal(result.status, 1);
    assert.equal(fs.existsSync(itemFile(cwd, 'evidence', 'verify.md')), false);
    assert.equal(fs.existsSync(itemFile(cwd, 'evidence', 'verify-failed.md')), true);
  });

  test('evidence stops counting when the code changes', (t) => {
    const cwd = atVerify(t, 'true');
    sdlc(cwd, 'verify');
    touch(cwd, 'src/api/a.py', 'changed after verify\n');
    const result = sdlc(cwd, 'advance');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /write evidence\/verify\.md/);
  });

  test('committing the code doesn\'t invalidate evidence', (t) => {
    const cwd = atVerify(t, 'true');
    sdlc(cwd, 'verify');
    commitAll(cwd);
    assert.equal(sdlc(cwd, 'advance').status, 0);
  });

  test('a hand-written verify.md doesn\'t count', (t) => {
    const cwd = atVerify(t, 'true');
    touch(cwd, `.sdlc/work/${ID}/evidence/verify.md`, 'all tests passed, trust me\n');
    assert.equal(sdlc(cwd, 'advance').status, 1);
  });

  test('refuses before the verify stage', (t) => {
    const cwd = atBuild(t);
    assert.match(sdlc(cwd, 'verify').stderr, /is at build, not verify/);
  });

  test('refuses with no verify command', (t) => {
    const cwd = atVerify(t, 'true');
    const file = path.join(cwd, '.sdlc', 'config.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.commands.verify = null;
    fs.writeFileSync(file, JSON.stringify(config));
    assert.match(sdlc(cwd, 'verify').stderr, /set commands\.verify/);
  });
});

describe('the builder stop hook', () => {
  test('lets a clean build stop', (t) => {
    const cwd = atBuild(t);
    touch(cwd, 'src/api/a.py');
    const result = stop(cwd);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });

  test('sends an out-of-scope build back with the reason', (t) => {
    const cwd = atBuild(t);
    touch(cwd, 'src/other/a.py');
    const output = JSON.parse(stop(cwd).stdout);
    assert.equal(output.decision, 'block');
    assert.match(output.reason, /outside the spec's scope: src\/other\/a\.py/);
  });

  test('sends a failing build back with the output', (t) => {
    const cwd = atBuild(t, 'echo boom; exit 1');
    touch(cwd, 'src/api/a.py');
    const output = JSON.parse(stop(cwd).stdout);
    assert.equal(output.decision, 'block');
    assert.match(output.reason, /boom/);
  });

  test('gives up after the limit, rather than looping', (t) => {
    const cwd = atBuild(t);
    touch(cwd, 'src/other/a.py');
    for (let i = 0; i < 3; i += 1) assert.equal(JSON.parse(stop(cwd).stdout).decision, 'block');
    const last = stop(cwd);
    assert.equal(last.status, 0);
    assert.equal(last.stdout, '');
    assert.match(last.stderr, /giving up/);
  });

  test('other roles are left alone', (t) => {
    const cwd = atBuild(t);
    touch(cwd, 'src/other/a.py');
    assert.equal(stop(cwd, { agent_type: 'sdlc:reviewer' }).stdout, '');
    assert.equal(stop(cwd, { agent_type: '' }).stdout, '');
  });

  test('does nothing when no item is at build', (t) => {
    const cwd = repo(t);
    sdlc(cwd, 'new', 'feature');
    touch(cwd, 'src/other/a.py');
    assert.equal(stop(cwd).stdout, '');
  });
});
