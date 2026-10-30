'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const PLUGIN = path.join(__dirname, '..', 'plugins', 'sdlc');
const CLI = path.join(PLUGIN, 'bin', 'sdlc');
const HOOK = path.join(PLUGIN, 'scripts', 'hook.js');

function env() {
  return { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
}

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, env: env(), stdio: 'ignore' });
}

function sdlc(cwd, ...args) {
  return spawnSync(CLI, args, { cwd, encoding: 'utf8', env: env() });
}

function hook(event, input) {
  return spawnSync('node', [HOOK, event], { input: JSON.stringify(input), encoding: 'utf8', env: env() });
}

// A repo with a worktree where Claude Code puts them.
function repo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-worktree-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'first');
  return dir;
}

function worktree(root, name) {
  const dir = path.join(root, '.claude', 'worktrees', name);
  git(root, 'worktree', 'add', '-q', '-b', `worktree-${name}`, dir);
  return dir;
}

function commitFactory(root) {
  sdlc(root, 'init');
  git(root, 'add', '.sdlc');
  git(root, 'commit', '-q', '-m', 'add factory');
}

test('a worktree with its own .sdlc/ uses that one', (t) => {
  const root = repo(t);
  commitFactory(root);
  const dir = worktree(root, 'a');
  assert.equal(JSON.parse(sdlc(dir, 'status', '--json').stdout).root, dir);
});

test('a worktree never reaches up to the main checkout', (t) => {
  const root = repo(t);
  const dir = worktree(root, 'a');
  sdlc(root, 'init');
  const status = JSON.parse(sdlc(dir, 'status', '--json').stdout);
  assert.equal(status.initialized, false);
  assert.equal(status.root, null);
  assert.equal(sdlc(dir, 'new', 'x').status, 1);
  assert.deepEqual(fs.readdirSync(path.join(root, '.sdlc', 'work')), []);
});

test('the main checkout\'s rules are not applied through the wrong path', (t) => {
  const root = repo(t);
  const dir = worktree(root, 'a');
  sdlc(root, 'init');
  sdlc(root, 'new', 'feature');
  const input = { cwd: dir, tool_input: { file_path: path.join(dir, 'src', 'a.py') } };
  assert.equal(hook('pre-edit', input).stderr, '');
});

test('status warns when the gates are off in a worktree', (t) => {
  const root = repo(t);
  const dir = worktree(root, 'a');
  sdlc(root, 'init');
  assert.equal(JSON.parse(sdlc(dir, 'status', '--json').stdout).main_checkout, root);
  assert.match(sdlc(dir, 'status').stdout, /gates are off/);
});

test('session start warns too', (t) => {
  const root = repo(t);
  const dir = worktree(root, 'a');
  sdlc(root, 'init');
  assert.match(hook('session-start', { cwd: dir }).stdout, /gates are off/);
});

test('no warning from a subfolder of an ordinary repo', (t) => {
  const root = repo(t);
  const sub = path.join(root, 'src');
  fs.mkdirSync(sub);
  assert.deepEqual(JSON.parse(sdlc(sub, 'status', '--json').stdout), { initialized: false, root: null });
  assert.equal(hook('session-start', { cwd: sub }).stdout, '');
});

test('no warning in a worktree of a repo without the factory', (t) => {
  const root = repo(t);
  const dir = worktree(root, 'a');
  assert.deepEqual(JSON.parse(sdlc(dir, 'status', '--json').stdout), { initialized: false, root: null });
});

test('a worktree from a subfolder is still found', (t) => {
  const root = repo(t);
  commitFactory(root);
  const dir = worktree(root, 'a');
  const sub = path.join(dir, 'src');
  fs.mkdirSync(sub);
  assert.equal(JSON.parse(sdlc(sub, 'status', '--json').stdout).root, dir);
});
