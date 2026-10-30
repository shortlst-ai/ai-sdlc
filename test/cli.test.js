'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const CLI = path.join(__dirname, '..', 'plugins', 'sdlc', 'bin', 'sdlc');

function run(args, cwd) {
  return spawnSync(CLI, args, { cwd, encoding: 'utf8' });
}

function tempDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-test-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function repo(t) {
  const dir = tempDir(t);
  assert.equal(run(['init'], dir).status, 0);
  return dir;
}

function status(cwd, ...args) {
  return JSON.parse(run(['status', '--json', ...args], cwd).stdout);
}

function itemDir(cwd, id) {
  return path.join(cwd, '.sdlc', 'work', id);
}

function write(cwd, id, artifact, content = 'draft') {
  const file = path.join(itemDir(cwd, id), artifact);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function approve(cwd, id, stage, artifact) {
  const bytes = fs.readFileSync(path.join(itemDir(cwd, id), artifact));
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  write(cwd, id, `approvals/${stage}.json`, JSON.stringify({ sha256 }));
}

function readState(cwd, id) {
  return JSON.parse(fs.readFileSync(path.join(itemDir(cwd, id), 'state.json'), 'utf8'));
}

test('prints the version from plugin.json', (t) => {
  const manifest = path.join(CLI, '..', '..', '.claude-plugin', 'plugin.json');
  const { version } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const result = run(['--version'], tempDir(t));
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), version);
});

test('status reports a repo without the factory', (t) => {
  const result = run(['status', '--json'], tempDir(t));
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { initialized: false, root: null });
});

test('status finds the factory from a subfolder', (t) => {
  const root = repo(t);
  const nested = path.join(root, 'src', 'deep');
  fs.mkdirSync(nested, { recursive: true });
  assert.deepEqual(status(nested), {
    initialized: true,
    root,
    items: [],
    next: { action: 'new' },
  });
});

test('an unknown command fails with usage on stderr', (t) => {
  const result = run(['nope'], tempDir(t));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command 'nope'/);
  assert.equal(result.stdout, '');
});

test('names inherited from Object are not commands', (t) => {
  assert.equal(run(['constructor'], tempDir(t)).status, 2);
});

test('an unknown flag is a usage error', (t) => {
  assert.equal(run(['status', '--nope'], repo(t)).status, 2);
});

test('commands outside the factory are refused', (t) => {
  const result = run(['new', 'x'], tempDir(t));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /sdlc init/);
});

test('init refuses to run twice', (t) => {
  assert.equal(run(['init'], repo(t)).status, 1);
});

test('new creates a standard item by default and numbers in order', (t) => {
  const cwd = repo(t);
  assert.equal(run(['new', 'first'], cwd).status, 0);
  assert.equal(run(['new', 'second'], cwd).status, 0);
  const { items } = status(cwd);
  assert.deepEqual(items.map((item) => item.id), ['0001-first', '0002-second']);
  assert.equal(items[0].track, 'standard');
  assert.equal(items[0].stage, 'spec');
});

test('new rejects slugs that could escape the work folder', (t) => {
  const cwd = repo(t);
  for (const slug of ['../evil', 'a/b', 'UPPER', '-x', '.']) {
    assert.equal(run(['new', slug], cwd).status, 2, slug);
  }
  assert.deepEqual(status(cwd).items, []);
});

test('files decide the track', (t) => {
  const cwd = repo(t);
  assert.equal(run(['new', 'fix', '--files', 'a.py,b.py'], cwd).status, 0);
  assert.equal(status(cwd).items[0].track, 'quick');
});

test('critical paths in config raise the track', (t) => {
  const cwd = repo(t);
  const file = path.join(cwd, '.sdlc', 'config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.tracks.critical.paths = ['src/auth/**'];
  fs.writeFileSync(file, JSON.stringify(config));
  run(['new', 'login', '--files', 'src/auth/a.py'], cwd);
  assert.equal(status(cwd).items[0].track, 'critical');
});

test('new may raise the track but never lower it', (t) => {
  const cwd = repo(t);
  assert.equal(run(['new', 'a', '--track', 'critical'], cwd).status, 0);
  const lowered = run(['new', 'b', '--track', 'quick'], cwd);
  assert.equal(lowered.status, 1);
  assert.match(lowered.stderr, /at least the 'standard' track/);
  assert.equal(status(cwd).items.length, 1);
});

test('advance follows the gates and refuses until each passes', (t) => {
  const cwd = repo(t);
  run(['new', 'feature'], cwd);
  const id = '0001-feature';

  let result = run(['advance'], cwd);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /write spec.md/);

  write(cwd, id, 'spec.md');
  assert.equal(status(cwd).next.action, 'approve');
  result = run(['advance'], cwd);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /a person must approve spec/);

  approve(cwd, id, 'spec', 'spec.md');
  assert.equal(run(['advance'], cwd).status, 0);
  assert.equal(status(cwd).items[0].stage, 'plan');

  write(cwd, id, 'spec.md', 'edited after approval');
  const next = status(cwd).next;
  assert.equal(next.action, 'approve');
  assert.equal(next.stale, true);
  assert.equal(run(['advance'], cwd).status, 1);
});

test('a full quick run reaches done and records its history', (t) => {
  const cwd = repo(t);
  run(['new', 'fix', '--files', 'a.py'], cwd);
  const id = '0001-fix';
  write(cwd, id, 'evidence/reproduce.md');
  write(cwd, id, 'evidence/verify.md');
  write(cwd, id, 'evidence/review.md');
  approve(cwd, id, 'merge', 'evidence/review.md');
  for (let i = 0; i < 5; i += 1) assert.equal(run(['advance'], cwd).status, 0);
  assert.deepEqual(status(cwd).items[0].next, { action: 'none' });
  assert.equal(status(cwd).next.action, 'new');
  assert.equal(readState(cwd, id).history.length, 5);
  assert.equal(run(['advance', id], cwd).status, 1);
});

test('a forged approval with the wrong hash does not open a gate', (t) => {
  const cwd = repo(t);
  run(['new', 'feature'], cwd);
  write(cwd, '0001-feature', 'spec.md');
  write(cwd, '0001-feature', 'approvals/spec.json', JSON.stringify({ sha256: 'wrong' }));
  assert.equal(run(['advance'], cwd).status, 1);
});

test('an unreadable approval does not open a gate', (t) => {
  const cwd = repo(t);
  run(['new', 'feature'], cwd);
  write(cwd, '0001-feature', 'spec.md');
  write(cwd, '0001-feature', 'approvals/spec.json', 'not json');
  assert.equal(run(['advance'], cwd).status, 1);
});

test('rework needs a reason and records it', (t) => {
  const cwd = repo(t);
  run(['new', 'fix', '--files', 'a.py'], cwd);
  const id = '0001-fix';
  assert.equal(run(['rework'], cwd).status, 2);
  assert.equal(run(['rework', '--reason', 'x'], cwd).status, 1);
  write(cwd, id, 'evidence/reproduce.md');
  run(['advance'], cwd);
  run(['advance'], cwd);
  assert.equal(run(['rework', '--reason', 'tests failed'], cwd).status, 0);
  const state = readState(cwd, id);
  assert.equal(state.stage, 'build');
  assert.equal(state.rework, 1);
  assert.equal(state.history.at(-1).reason, 'tests failed');
});

test('rework retires old evidence, so the next round must produce its own', (t) => {
  const cwd = repo(t);
  run(['new', 'fix', '--files', 'a.py'], cwd);
  const id = '0001-fix';
  write(cwd, id, 'evidence/reproduce.md');
  write(cwd, id, 'evidence/verify.md', 'round one');
  write(cwd, id, 'evidence/review.md', 'round one');
  approve(cwd, id, 'merge', 'evidence/review.md');
  for (let i = 0; i < 3; i += 1) run(['advance'], cwd);
  assert.equal(readState(cwd, id).stage, 'review');
  assert.equal(run(['rework', '--reason', 'critical finding'], cwd).status, 0);

  assert.equal(run(['advance'], cwd).status, 0);
  const refused = run(['advance'], cwd);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /write evidence\/verify.md/);

  const archive = path.join(itemDir(cwd, id), 'evidence', 'rework-1');
  assert.deepEqual(fs.readdirSync(archive).sort(), ['merge.json', 'review.md', 'verify.md']);
  assert.equal(fs.readFileSync(path.join(archive, 'verify.md'), 'utf8'), 'round one');

  // The earlier reproduction stays, because it isn't about the code being reworked.
  assert.equal(fs.existsSync(path.join(itemDir(cwd, id), 'evidence', 'reproduce.md')), true);
});

test('track raises from a name or from files, and never lowers', (t) => {
  const cwd = repo(t);
  run(['new', 'feature'], cwd);
  assert.equal(run(['track', 'quick'], cwd).status, 1);
  assert.equal(status(cwd).items[0].track, 'standard');

  // These files classify as quick, which must not lower a standard item.
  assert.equal(run(['track', '--files', 'a.py'], cwd).status, 0);
  assert.equal(status(cwd).items[0].track, 'standard');

  assert.equal(run(['track', 'critical'], cwd).status, 0);
  assert.equal(status(cwd).items[0].track, 'critical');
  assert.equal(status(cwd).items[0].stage, 'spec');
});

test('track needs a track or files', (t) => {
  const cwd = repo(t);
  run(['new', 'feature'], cwd);
  assert.equal(run(['track'], cwd).status, 2);
});

test('several open items must be named, and any unique number works', (t) => {
  const cwd = repo(t);
  run(['new', 'one'], cwd);
  run(['new', 'two'], cwd);
  assert.deepEqual(status(cwd).next, { action: 'choose', ids: ['0001-one', '0002-two'] });
  const result = run(['advance'], cwd);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /several open work items/);
  write(cwd, '0002-two', 'spec.md');
  approve(cwd, '0002-two', 'spec', 'spec.md');
  assert.equal(run(['advance', '2'], cwd).status, 0);
  assert.equal(status(cwd, '2').items[0].stage, 'plan');
});

test('the same number on two branches is reported as ambiguous', (t) => {
  const cwd = repo(t);
  run(['new', 'one'], cwd);
  fs.cpSync(itemDir(cwd, '0001-one'), itemDir(cwd, '0001-other'), { recursive: true });
  const result = run(['advance', '1'], cwd);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ambiguous/);
});

test('an unknown id is refused without creating anything', (t) => {
  const cwd = repo(t);
  assert.equal(run(['advance', '../../etc'], cwd).status, 1);
});

test('corrupt state is reported, not trusted', (t) => {
  const cwd = repo(t);
  run(['new', 'feature'], cwd);
  const file = path.join(itemDir(cwd, '0001-feature'), 'state.json');
  fs.writeFileSync(file, '{ not json');
  assert.match(run(['advance'], cwd).stderr, /can't read state/);
  fs.writeFileSync(file, JSON.stringify({ track: 'standard', stage: 'made-up', rework: 0, history: [] }));
  assert.match(run(['advance'], cwd).stderr, /invalid/);
});

test('a config with the wrong shape is refused', (t) => {
  const cwd = repo(t);
  fs.writeFileSync(path.join(cwd, '.sdlc', 'config.json'), '{"version": 1}');
  const result = run(['new', 'x'], cwd);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /expected shape/);
});
