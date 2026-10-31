'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');

const { outOfScope, parseScope } = require('../plugins/sdlc/lib/check');

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

const PLAN = '# Plan\n\n```scope name=api\nsrc/api/**\n```\n';

// A standard item at build, with a plan that allows src/api/.
function atBuild(t, verify, plan = PLAN) {
  const cwd = repo(t, verify);
  assert.equal(sdlc(cwd, 'new', 'feature').status, 0);
  touch(cwd, `.sdlc/work/${ID}/spec.md`, 'spec');
  touch(cwd, `.sdlc/work/${ID}/plan.md`, plan);
  const sha256 = crypto.createHash('sha256').update('spec').digest('hex');
  touch(cwd, `.sdlc/work/${ID}/approvals/spec.json`, JSON.stringify({ sha256 }));
  assert.equal(sdlc(cwd, 'advance').status, 0);
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
  test('lists what the plan didn\'t allow', () => {
    assert.deepEqual(outOfScope(['src/a.py', 'src/b.py'], ['src/a.py'], []), ['src/b.py']);
  });

  test('test files are always in scope', () => {
    assert.deepEqual(outOfScope(['tests/test_a.py'], ['src/**'], ['tests/**']), []);
  });
});

describe('the scope check', () => {
  test('passes when changes match the plan', (t) => {
    const cwd = atBuild(t);
    touch(cwd, 'src/api/a.py');
    assert.equal(sdlc(cwd, 'check').status, 0);
    assert.equal(sdlc(cwd, 'advance').status, 0);
  });

  test('catches uncommitted, untracked work outside the plan', (t) => {
    const cwd = atBuild(t);
    touch(cwd, 'src/other/a.py');
    const result = sdlc(cwd, 'check');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /outside the plan's scope: src\/other\/a\.py/);
  });

  test('catches work that was committed', (t) => {
    const cwd = atBuild(t);
    touch(cwd, 'src/other/a.py');
    commitAll(cwd);
    assert.match(sdlc(cwd, 'check').stderr, /outside the plan's scope: src\/other\/a\.py/);
  });

  test('catches a deleted file', (t) => {
    const cwd = repo(t);
    touch(cwd, 'src/other/a.py');
    commitAll(cwd);
    sdlc(cwd, 'new', 'feature');
    touch(cwd, `.sdlc/work/${ID}/spec.md`, 'spec');
    touch(cwd, `.sdlc/work/${ID}/plan.md`, PLAN);
    const sha256 = crypto.createHash('sha256').update('spec').digest('hex');
    touch(cwd, `.sdlc/work/${ID}/approvals/spec.json`, JSON.stringify({ sha256 }));
    sdlc(cwd, 'advance');
    sdlc(cwd, 'advance');
    fs.rmSync(path.join(cwd, 'src/other/a.py'));
    assert.match(sdlc(cwd, 'check').stderr, /outside the plan's scope/);
  });

  test('a build can\'t advance outside its scope', (t) => {
    const cwd = atBuild(t);
    touch(cwd, 'src/other/a.py');
    const result = sdlc(cwd, 'advance');
    assert.equal(result.status, 1);
    assert.equal(state(cwd).stage, 'build');
  });

  test('a plan with no scope block can\'t leave build', (t) => {
    const cwd = atBuild(t, 'true', '# Plan with no scope');
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
    const cwd = repo(t);
    sdlc(cwd, 'new', 'feature', '--files', 'src/a.py');
    assert.equal(state(cwd).track, 'quick');
    touch(cwd, `.sdlc/work/${ID}/evidence/reproduce.md`);
    sdlc(cwd, 'advance');
    touch(cwd, 'src/a.py');
    touch(cwd, 'src/auth/login.py');
    const config = path.join(cwd, '.sdlc', 'config.json');
    assert.equal(fs.existsSync(config), true);
    const scoped = JSON.parse(fs.readFileSync(itemFile(cwd, 'state.json'), 'utf8'));
    scoped.files = ['src/**'];
    fs.writeFileSync(itemFile(cwd, 'state.json'), JSON.stringify(scoped));
    touch(cwd, `.sdlc/work/${ID}/plan.md`, '```scope\nsrc/**\n```\n');
    const result = sdlc(cwd, 'advance');
    assert.match(result.stdout, /track was raised/);
    assert.equal(state(cwd).track, 'critical');
    assert.equal(state(cwd).stage, 'build');
  });

  test('an empty diff doesn\'t raise a quick item', (t) => {
    const cwd = repo(t);
    sdlc(cwd, 'new', 'feature', '--files', 'src/a.py');
    touch(cwd, `.sdlc/work/${ID}/evidence/reproduce.md`);
    sdlc(cwd, 'advance');
    assert.equal(sdlc(cwd, 'advance').status, 0);
    assert.equal(state(cwd).track, 'quick');
  });

  test('a small change never lowers a standard item', (t) => {
    const cwd = atBuild(t);
    touch(cwd, 'src/api/a.py');
    sdlc(cwd, 'advance');
    assert.equal(state(cwd).track, 'standard');
  });
});

describe('the quick track\'s test lock', () => {
  function quick(t) {
    const cwd = repo(t);
    sdlc(cwd, 'new', 'feature', '--files', 'src/a.py');
    touch(cwd, 'tests/test_a.py', 'failing test\n');
    touch(cwd, `.sdlc/work/${ID}/evidence/reproduce.md`);
    commitAll(cwd, 'the failing test');
    assert.equal(sdlc(cwd, 'advance').status, 0);
    return cwd;
  }

  test('the fix passes when the test is untouched', (t) => {
    const cwd = quick(t);
    touch(cwd, 'src/a.py');
    assert.equal(sdlc(cwd, 'check').status, 0);
  });

  test('editing the test during the fix is caught', (t) => {
    const cwd = quick(t);
    touch(cwd, 'tests/test_a.py', 'weakened test\n');
    assert.match(sdlc(cwd, 'check').stderr, /tests changed during the fix: tests\/test_a\.py/);
  });

  test('committing the edit doesn\'t hide it', (t) => {
    const cwd = quick(t);
    touch(cwd, 'tests/test_a.py', 'weakened test\n');
    commitAll(cwd);
    assert.match(sdlc(cwd, 'check').stderr, /tests changed during the fix/);
  });

  test('declared files are the scope', (t) => {
    const cwd = quick(t);
    touch(cwd, 'src/b.py');
    assert.match(sdlc(cwd, 'check').stderr, /outside the plan's scope: src\/b\.py/);
  });
});

describe('sdlc verify', () => {
  function atVerify(t, command) {
    const cwd = atBuild(t, command);
    touch(cwd, 'src/api/a.py');
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
    assert.match(output.reason, /outside the plan's scope: src\/other\/a\.py/);
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
