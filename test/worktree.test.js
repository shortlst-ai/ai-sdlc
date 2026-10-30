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

function configure(root, setup) {
  const file = path.join(root, '.sdlc', 'config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.commands.setup = setup;
  fs.writeFileSync(file, JSON.stringify(config));
}

function factoryWorktree(t, setup) {
  const root = repo(t);
  sdlc(root, 'init');
  if (setup) configure(root, setup);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'add factory');
  return { root, dir: worktree(root, 'a') };
}

function items(cwd) {
  return JSON.parse(sdlc(cwd, 'status', '--json').stdout).items.map((item) => item.id);
}

test('an item records the branch it was created on', (t) => {
  const { dir } = factoryWorktree(t);
  sdlc(dir, 'new', 'feature');
  const state = fs.readFileSync(path.join(dir, '.sdlc', 'work', '0001-feature', 'state.json'), 'utf8');
  assert.equal(JSON.parse(state).branch, 'worktree-a');
});

test('a session sees only its own branch\'s items', (t) => {
  const { root, dir } = factoryWorktree(t);
  sdlc(root, 'new', 'base');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'item on main');
  git(dir, 'merge', '-q', 'main');
  sdlc(dir, 'new', 'feature');
  assert.deepEqual(items(dir), ['0002-feature']);
  assert.deepEqual(items(root), ['0001-base']);
});

test('another branch\'s open item doesn\'t block or unblock an edit', (t) => {
  const { root, dir } = factoryWorktree(t);
  sdlc(root, 'new', 'base');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'item on main');
  git(dir, 'merge', '-q', 'main');
  const input = { cwd: dir, tool_input: { file_path: path.join(dir, 'a.py') } };
  assert.equal(hook('pre-edit', input).status, 0);
  sdlc(dir, 'new', 'feature');
  assert.equal(hook('pre-edit', input).status, 2);
});

test('with one open item on the branch, commands need no id', (t) => {
  const { dir } = factoryWorktree(t);
  sdlc(dir, 'new', 'feature');
  assert.equal(JSON.parse(sdlc(dir, 'status', '--json').stdout).next.id, '0001-feature');
  assert.match(sdlc(dir, 'advance').stderr, /write spec\.md/);
});

test('session start lists only this branch\'s work', (t) => {
  const { root, dir } = factoryWorktree(t);
  sdlc(root, 'new', 'base');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'item on main');
  git(dir, 'merge', '-q', 'main');
  assert.equal(hook('session-start', { cwd: dir }).stdout, '');
});

test('init finds the repo root from a subfolder', (t) => {
  const root = repo(t);
  const sub = path.join(root, 'src');
  fs.mkdirSync(sub);
  sdlc(sub, 'init');
  assert.equal(fs.existsSync(path.join(root, '.sdlc')), true);
  assert.equal(fs.existsSync(path.join(sub, '.sdlc')), false);
});

test('init ignores worktrees and turns on agent teams', (t) => {
  const root = repo(t);
  sdlc(root, 'init');
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), '.claude/worktrees/\n');
  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, '1');
});

test('init keeps what the project already has', (t) => {
  const root = repo(t);
  fs.mkdirSync(path.join(root, '.claude'));
  const existing = { permissions: { allow: ['Bash(make *)'] }, env: { FOO: 'bar' } };
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify(existing));
  fs.writeFileSync(path.join(root, '.gitignore'), 'data/');
  sdlc(root, 'init');
  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(settings.permissions.allow, ['Bash(make *)', 'Bash(sdlc *)']);
  assert.equal(settings.env.FOO, 'bar');
  assert.equal(settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, '1');
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), 'data/\n.claude/worktrees/\n');
});

test('init allows the CLI, which can\'t approve anything', (t) => {
  const root = repo(t);
  sdlc(root, 'init');
  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(settings.permissions.allow, ['Bash(sdlc *)']);
});

test('init doesn\'t repeat an ignore line that\'s already there', (t) => {
  const root = repo(t);
  fs.writeFileSync(path.join(root, '.gitignore'), '.claude/worktrees/\nother\n');
  sdlc(root, 'init');
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), '.claude/worktrees/\nother\n');
});

test('init refuses to overwrite settings it can\'t read', (t) => {
  const root = repo(t);
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{ nope');
  assert.equal(sdlc(root, 'init').status, 1);
  assert.equal(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'), '{ nope');
});

test('setup runs in the worktree and leaves no tracked change', (t) => {
  const { dir } = factoryWorktree(t, 'touch built.txt');
  const result = sdlc(dir, 'setup');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(dir, 'built.txt')), true);
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8', env: env() });
  assert.equal(status, '?? built.txt\n');
});

test('session start asks for setup once per worktree', (t) => {
  const { dir } = factoryWorktree(t, 'true');
  assert.match(hook('session-start', { cwd: dir }).stdout, /sdlc setup/);
  sdlc(dir, 'setup');
  assert.equal(hook('session-start', { cwd: dir }).stdout, '');
});

test('each worktree tracks its own setup', (t) => {
  const { root, dir } = factoryWorktree(t, 'true');
  sdlc(dir, 'setup');
  const other = worktree(root, 'b');
  assert.match(hook('session-start', { cwd: other }).stdout, /sdlc setup/);
});

test('changing the setup command asks again', (t) => {
  const { dir } = factoryWorktree(t, 'true');
  sdlc(dir, 'setup');
  configure(dir, 'true && true');
  assert.match(hook('session-start', { cwd: dir }).stdout, /sdlc setup/);
});

test('failed setup is reported and not marked done', (t) => {
  const { dir } = factoryWorktree(t, 'exit 3');
  const result = sdlc(dir, 'setup');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /setup failed/);
  assert.match(hook('session-start', { cwd: dir }).stdout, /sdlc setup/);
});

test('the main checkout is not asked to run setup', (t) => {
  const { root } = factoryWorktree(t, 'true');
  assert.equal(hook('session-start', { cwd: root }).stdout, '');
});

test('with no setup command, setup says so', (t) => {
  const { dir } = factoryWorktree(t);
  assert.match(sdlc(dir, 'setup').stdout, /nothing to do/);
});
