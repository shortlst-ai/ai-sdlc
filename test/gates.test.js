'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const PLUGIN = path.join(__dirname, '..', 'plugins', 'sdlc');
const CLI = path.join(PLUGIN, 'bin', 'sdlc');
const ID = '0001-feature';
const PLAN = '```scope\nsrc/**\n```\n';

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

function commitAll(cwd) {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'work');
}

function sha(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

const item = (name) => `.sdlc/work/${ID}/${name}`;

function approve(cwd, stage, content) {
  const record = { sha256: sha(content), approver: { name: 'Ada', email: 'ada@example.com' } };
  touch(cwd, item(`approvals/${stage}.json`), JSON.stringify(record));
}

function repo(t, { critical = [] } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-gates-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  sdlc(dir, 'init', '--verify', 'true', '--critical', critical.join(','));
  commitAll(dir);
  return dir;
}

function setCritical(cwd, paths) {
  const file = path.join(cwd, '.sdlc', 'config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.tracks.critical.paths = paths;
  fs.writeFileSync(file, JSON.stringify(config));
}

// A finished standard change on a branch, every gate properly passed. With
// `critical`, the base branch has a stricter rule that the local gates were
// hidden from, as they would be for an agent that loosened its own config.
function finished(t, options) {
  const cwd = repo(t, options);
  git(cwd, 'switch', '-q', '-c', 'feature');
  if (options) setCritical(cwd, []);
  sdlc(cwd, 'new', 'feature');
  touch(cwd, item('spec.md'), 'spec');
  approve(cwd, 'spec', 'spec');
  touch(cwd, item('plan.md'), PLAN);
  sdlc(cwd, 'advance');
  sdlc(cwd, 'advance');
  touch(cwd, 'src/a.py');
  sdlc(cwd, 'advance');
  sdlc(cwd, 'verify');
  sdlc(cwd, 'advance');
  touch(cwd, item('evidence/review.md'), 'pass');
  sdlc(cwd, 'advance');
  approve(cwd, 'merge', 'pass');
  assert.equal(sdlc(cwd, 'advance').status, 0);
  commitAll(cwd);
  return cwd;
}

function gates(cwd, ...args) {
  return sdlc(cwd, 'gates', '--base', 'main', ...args);
}

function problems(cwd) {
  return JSON.parse(gates(cwd, '--json').stdout).problems;
}

function state(cwd) {
  return JSON.parse(fs.readFileSync(path.join(cwd, item('state.json')), 'utf8'));
}

function editState(cwd, change) {
  const next = { ...state(cwd), ...change };
  touch(cwd, item('state.json'), JSON.stringify(next));
}

test('a change that followed the process passes', (t) => {
  const cwd = finished(t);
  const result = gates(cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Gates passed for 1 work items/);
});

test('a repo without the factory passes', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-gates-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  touch(dir, 'a.py');
  commitAll(dir);
  git(dir, 'switch', '-q', '-c', 'feature');
  touch(dir, 'b.py');
  commitAll(dir);
  assert.equal(gates(dir).status, 0);
});

test('a change that deletes the factory fails', (t) => {
  const cwd = repo(t);
  git(cwd, 'checkout', '-q', '-b', 'evil');
  git(cwd, 'rm', '-rq', '.sdlc');
  touch(cwd, 'src/unreviewed.js');
  commitAll(cwd);
  fs.rmSync(path.join(cwd, '.sdlc'), { recursive: true, force: true });

  const result = sdlc(cwd, 'gates', '--base', 'main');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /removes the factory config/);
});

test('a change that deletes only the config fails, so it can\'t be done in two steps', (t) => {
  const cwd = repo(t);
  git(cwd, 'checkout', '-q', '-b', 'evil');
  git(cwd, 'rm', '-q', '.sdlc/config.json');
  commitAll(cwd);

  const result = sdlc(cwd, 'gates', '--base', 'main');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /removes the factory config/);
});

test('a leftover folder doesn\'t hide a deleted factory', (t) => {
  const cwd = repo(t);
  git(cwd, 'checkout', '-q', '-b', 'evil');
  git(cwd, 'rm', '-rq', '.sdlc');
  commitAll(cwd);
  fs.mkdirSync(path.join(cwd, '.sdlc', 'work'), { recursive: true });
  assert.equal(sdlc(cwd, 'gates', '--base', 'main').status, 1);
});

test('unrelated history is refused, even with no factory in the change', (t) => {
  const cwd = repo(t);
  git(cwd, 'checkout', '-q', '--orphan', 'evil');
  git(cwd, 'rm', '-rfq', '.');
  fs.rmSync(path.join(cwd, '.sdlc'), { recursive: true, force: true });
  touch(cwd, 'unreviewed.js');
  commitAll(cwd);

  const result = sdlc(cwd, 'gates', '--base', 'main');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /merge base/);
});

test('code with no work item fails', (t) => {
  const cwd = repo(t);
  git(cwd, 'switch', '-q', '-c', 'feature');
  touch(cwd, 'src/a.py');
  commitAll(cwd);
  assert.equal(gates(cwd).status, 1);
  assert.deepEqual(problems(cwd), ['this change has no work item']);
});

test('a forged approval with the wrong hash fails', (t) => {
  const cwd = finished(t);
  touch(cwd, item('approvals/spec.json'), JSON.stringify({ sha256: 'x', approver: { email: 'a' } }));
  commitAll(cwd);
  assert.match(problems(cwd).join(), /spec: spec\.md changed after approval/);
});

test('an approval naming nobody fails', (t) => {
  const cwd = finished(t);
  touch(cwd, item('approvals/spec.json'), JSON.stringify({ sha256: sha('spec') }));
  commitAll(cwd);
  assert.match(problems(cwd).join(), /the approval names nobody/);
});

test('a deleted approval fails', (t) => {
  const cwd = finished(t);
  fs.rmSync(path.join(cwd, item('approvals/merge.json')));
  commitAll(cwd);
  assert.match(problems(cwd).join(), /merge: no approval/);
});

test('editing a spec after approval fails', (t) => {
  const cwd = finished(t);
  touch(cwd, item('spec.md'), 'quietly different');
  commitAll(cwd);
  assert.match(problems(cwd).join(), /spec\.md changed after approval/);
});

test('editing state.json to claim done doesn\'t skip anything', (t) => {
  const cwd = repo(t);
  git(cwd, 'switch', '-q', '-c', 'feature');
  sdlc(cwd, 'new', 'feature');
  touch(cwd, 'src/a.py');
  editState(cwd, { stage: 'done' });
  commitAll(cwd);
  const found = problems(cwd).join('|');
  assert.match(found, /spec: spec\.md is missing/);
  assert.match(found, /merge: evidence\/review\.md is missing/);
});

test('editing the base in state.json can\'t hide work', (t) => {
  const cwd = finished(t);
  touch(cwd, 'src/other/../../secret-work.py');
  commitAll(cwd);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  editState(cwd, { base: head });
  commitAll(cwd);
  assert.match(problems(cwd).join(), /outside the plan's scope: secret-work\.py/);
});

test('work outside the plan fails even when committed', (t) => {
  const cwd = finished(t);
  touch(cwd, 'docs/extra.md');
  commitAll(cwd);
  assert.match(problems(cwd).join(), /outside the plan's scope: docs\/extra\.md/);
});

test('code changed after verify fails', (t) => {
  const cwd = finished(t);
  touch(cwd, 'src/a.py', 'changed after the tests ran\n');
  commitAll(cwd);
  assert.match(problems(cwd).join(), /verify: evidence\/verify\.md is missing or out of date/);
});

test('an unfinished item fails', (t) => {
  const cwd = repo(t);
  git(cwd, 'switch', '-q', '-c', 'feature');
  sdlc(cwd, 'new', 'feature');
  commitAll(cwd);
  assert.match(problems(cwd).join(), /it's at spec, not finished/);
});

test('an abandoned item fails', (t) => {
  const cwd = finished(t);
  editState(cwd, { stage: 'abandoned' });
  commitAll(cwd);
  assert.deepEqual(problems(cwd), [`${ID}: it was abandoned`]);
});

test('a change can\'t loosen the rules judging it', (t) => {
  const cwd = finished(t, { critical: ['src/**'] });
  assert.match(problems(cwd).join(), /its files need the critical track, not standard/);
});

test('a track set too low fails', (t) => {
  const cwd = finished(t, { critical: ['src/**'] });
  setCritical(cwd, ['src/**']);
  commitAll(cwd);
  assert.match(problems(cwd).join(), /its files need the critical track, not standard/);
});

test('corrupt state fails rather than passing', (t) => {
  const cwd = finished(t);
  touch(cwd, item('state.json'), '{ nope');
  commitAll(cwd);
  assert.equal(gates(cwd).status, 1);
});

test('a missing base ref is refused', (t) => {
  const cwd = finished(t);
  const result = sdlc(cwd, 'gates', '--base', 'origin/nope');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /merge base/);
});

test('--base is required', (t) => {
  assert.equal(sdlc(repo(t), 'gates').status, 2);
});

const ROOT = path.join(__dirname, '..');
const WORKFLOWS = [
  path.join(PLUGIN, 'templates', 'sdlc-gates.yml'),
  path.join(ROOT, '.github', 'workflows', 'sdlc-gates.yml'),
];

for (const file of WORKFLOWS) {
  const name = path.relative(ROOT, file);
  const text = fs.readFileSync(file, 'utf8');

  // With pull_request, a change could edit this workflow and pass its own check.
  test(`${name} runs from the base branch`, () => {
    assert.match(text, /^ {2}pull_request_target:$/m);
    assert.doesNotMatch(text, /^ {2}pull_request:$/m);
  });

  // pull_request_target has base-branch rights, so it must never run the change.
  test(`${name} only runs code from outside the change`, () => {
    const commands = [...text.matchAll(/^ +- run: (.*)$/gm)].map((match) => match[1]);
    assert.ok(commands.length >= 2);
    for (const command of commands) {
      assert.match(command, /^(git (clone|worktree add) |node "\$RUNNER_TEMP\/)/, command);
    }
  });

  test(`${name} keeps the token away from the change's files`, () => {
    assert.match(text, /persist-credentials: false/);
    assert.match(text, /^permissions:\n {2}contents: read$/m);
  });

  test(`${name} has the history the gate needs`, () => {
    assert.match(text, /fetch-depth: 0/);
  });
}

test('tests run in a separate workflow, since they execute the change', () => {
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /^ {2}pull_request:$/m);
  assert.doesNotMatch(ci, /pull_request_target/);
});
