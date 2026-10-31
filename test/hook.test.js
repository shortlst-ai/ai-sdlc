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

function hook(event, input) {
  return spawnSync('node', [HOOK, event], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: env(),
  });
}

function sdlc(cwd, ...args) {
  const result = spawnSync(CLI, args, { cwd, encoding: 'utf8', env: env() });
  assert.equal(result.status, 0, result.stderr);
}

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, env: env(), stdio: 'ignore' });
}

function tempDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-hook-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function factory(t) {
  const dir = tempDir(t);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  sdlc(dir, 'init');
  return dir;
}

function configure(cwd, change) {
  const file = path.join(cwd, '.sdlc', 'config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  change(config);
  fs.writeFileSync(file, JSON.stringify(config));
}

// Puts a standard item at build by faking the approval the hook would record.
function atBuild(cwd) {
  sdlc(cwd, 'new', 'feature');
  const dir = path.join(cwd, '.sdlc', 'work', '0001-feature');
  fs.writeFileSync(path.join(dir, 'spec.md'), 'spec');
  fs.writeFileSync(path.join(dir, 'plan.md'), 'plan');
  const hash = require('node:crypto').createHash('sha256').update('spec').digest('hex');
  fs.mkdirSync(path.join(dir, 'approvals'));
  fs.writeFileSync(path.join(dir, 'approvals', 'spec.json'), JSON.stringify({ sha256: hash }));
  sdlc(cwd, 'advance');
  sdlc(cwd, 'advance');
  return dir;
}

function preEdit(cwd, file, extra = {}) {
  return hook('pre-edit', { cwd, tool_name: 'Write', tool_input: { file_path: file }, ...extra });
}

function preBash(cwd, command, extra = {}) {
  return hook('pre-bash', { cwd, tool_name: 'Bash', tool_input: { command }, ...extra });
}

test('every handler does nothing outside the factory', (t) => {
  const cwd = tempDir(t);
  const input = { cwd, tool_input: { file_path: 'a.py', command: 'git push origin main' } };
  for (const event of ['pre-edit', 'pre-bash', 'post-edit', 'session-start']) {
    const result = hook(event, input);
    assert.equal(result.status, 0, event);
    assert.equal(result.stdout, '', event);
    assert.equal(result.stderr, '', event);
  }
});

test('a refusal exits 2 with the reason on stderr, never 1', (t) => {
  const cwd = factory(t);
  sdlc(cwd, 'new', 'feature');
  const result = preEdit(cwd, 'src/a.py');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^sdlc: src\/a\.py can't be changed yet/);
});

test('pre-edit allows a source edit during build', (t) => {
  const cwd = factory(t);
  atBuild(cwd);
  assert.equal(preEdit(cwd, path.join(cwd, 'src/a.py')).status, 0);
});

test('pre-edit reads an edit from a subfolder as repo-relative', (t) => {
  const cwd = factory(t);
  fs.mkdirSync(path.join(cwd, 'src'));
  configure(cwd, (config) => {
    config.protected = ['src/gen/**'];
  });
  assert.equal(preEdit(path.join(cwd, 'src'), 'gen/a.py').status, 2);
});

test('pre-edit covers notebooks', (t) => {
  const cwd = factory(t);
  sdlc(cwd, 'new', 'feature');
  const input = { cwd, tool_name: 'NotebookEdit', tool_input: { notebook_path: 'a.ipynb' } };
  assert.equal(hook('pre-edit', input).status, 2);
});

test('pre-edit ignores files outside the repo', (t) => {
  const cwd = factory(t);
  sdlc(cwd, 'new', 'feature');
  assert.equal(preEdit(cwd, path.join(os.tmpdir(), 'notes.txt')).status, 0);
});

test('pre-edit sees through a symlink to a managed file', (t) => {
  const cwd = factory(t);
  sdlc(cwd, 'new', 'feature');
  const link = path.join(cwd, 'innocent.json');
  fs.symlinkSync(path.join(cwd, '.sdlc', 'work', '0001-feature', 'state.json'), link);
  const result = preEdit(cwd, link);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /managed/);
});

test('pre-edit applies the role from agent_type', (t) => {
  const cwd = factory(t);
  atBuild(cwd);
  const result = preEdit(cwd, 'src/a.py', { agent_type: 'sdlc:reviewer' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /reviewer role/);
});

function configDir(t, members) {
  const home = tempDir(t);
  const team = path.join(home, 'teams', 'session-be843abc');
  fs.mkdirSync(team, { recursive: true });
  const config = members === null ? '{ nope' : JSON.stringify({ name: 'session-be843abc', members });
  fs.writeFileSync(path.join(team, 'config.json'), config);
  return home;
}

function teammateEdit(cwd, home, file, name) {
  const input = {
    cwd,
    session_id: 'be843abc-1111-2222-3333-444444444444',
    agent_type: name,
    tool_name: 'Write',
    tool_input: { file_path: file },
  };
  return spawnSync('node', [HOOK, 'pre-edit'], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...env(), CLAUDE_CONFIG_DIR: home },
  });
}

test('a teammate is held to the role in the team config', (t) => {
  const cwd = factory(t);
  atBuild(cwd);
  const home = configDir(t, [
    { name: 'bob', agentType: 'sdlc:builder' },
    { name: 'rita', agentType: 'sdlc:reviewer' },
  ]);
  assert.equal(teammateEdit(cwd, home, 'src/a.py', 'bob').status, 0);
  const refused = teammateEdit(cwd, home, 'src/a.py', 'rita');
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /reviewer role/);
});

test('a teammate outside our roles can\'t write', (t) => {
  const cwd = factory(t);
  atBuild(cwd);
  const home = configDir(t, [{ name: 'sam', agentType: 'general-purpose' }]);
  const refused = teammateEdit(cwd, home, 'src/a.py', 'sam');
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /unassigned role/);
});

test('an unreadable team config fails closed', (t) => {
  const cwd = factory(t);
  atBuild(cwd);
  const refused = teammateEdit(cwd, configDir(t, null), 'src/a.py', 'bob');
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /can't check this action/);
});

test('no team config means no team', (t) => {
  const cwd = factory(t);
  atBuild(cwd);
  assert.equal(teammateEdit(cwd, tempDir(t), 'src/a.py', 'Explore').status, 0);
});

test('a session id can\'t steer the path to the team config', (t) => {
  const cwd = factory(t);
  atBuild(cwd);
  // Without the check, this id climbs out of teams/ to a config planted in the home folder.
  const home = configDir(t, []);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ members: [] }));
  const input = { cwd, session_id: 'a/../../', agent_type: 'sam', tool_input: { file_path: 'src/a.py' } };
  const result = spawnSync('node', [HOOK, 'pre-edit'], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...env(), CLAUDE_CONFIG_DIR: home },
  });
  assert.equal(result.status, 0);
});

test('corrupt state fails closed in the factory', (t) => {
  const cwd = factory(t);
  sdlc(cwd, 'new', 'feature');
  fs.writeFileSync(path.join(cwd, '.sdlc', 'work', '0001-feature', 'state.json'), '{ nope');
  const result = preEdit(cwd, 'src/a.py');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /can't check this action/);
});

test('pre-bash blocks a push from the default branch', (t) => {
  const cwd = factory(t);
  git(cwd, 'commit', '-q', '--allow-empty', '-m', 'first');
  assert.equal(preBash(cwd, 'git push').status, 2);
  git(cwd, 'switch', '-q', '-c', 'feature');
  assert.equal(preBash(cwd, 'git push').status, 0);
});

test('pre-bash sees a real staged secret and a real changed one', (t) => {
  const cwd = factory(t);
  fs.writeFileSync(path.join(cwd, '.env'), 'TOKEN=x');
  assert.equal(preBash(cwd, 'git add .').status, 2);
  git(cwd, 'add', '.env');
  const result = preBash(cwd, 'git commit -m x');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /commit secrets: .env/);
});

test('pre-bash ignores a gitignored secret', (t) => {
  const cwd = factory(t);
  fs.writeFileSync(path.join(cwd, '.gitignore'), '.env\n');
  fs.writeFileSync(path.join(cwd, '.env'), 'TOKEN=x');
  assert.equal(preBash(cwd, 'git add .').status, 0);
});

test('pre-bash allows ordinary commands', (t) => {
  const cwd = factory(t);
  assert.equal(preBash(cwd, 'make test').status, 0);
});

function postEdit(cwd, file) {
  return hook('post-edit', { cwd, tool_name: 'Write', tool_input: { file_path: file } });
}

test('post-edit runs the formatter on the changed file', (t) => {
  const cwd = factory(t);
  configure(cwd, (config) => {
    config.commands.format = 'echo formatted >> {file}';
  });
  const file = path.join(cwd, 'a.py');
  fs.writeFileSync(file, 'x\n');
  assert.equal(postEdit(cwd, file).status, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), 'x\nformatted\n');
});

test('post-edit treats a hostile file name as data, not shell', (t) => {
  const cwd = factory(t);
  configure(cwd, (config) => {
    config.commands.format = 'cat {file} > /dev/null';
  });
  const canary = path.join(cwd, 'canary');
  for (const name of ['x; touch canary; echo .py', '$(touch canary).py', '`touch canary`.py']) {
    const file = path.join(cwd, name);
    fs.writeFileSync(file, 'x\n');
    assert.equal(postEdit(cwd, file).status, 0, name);
    assert.equal(fs.existsSync(canary), false, name);
  }
});

test('post-edit does nothing with no formatter configured', (t) => {
  const cwd = factory(t);
  const file = path.join(cwd, 'a.py');
  fs.writeFileSync(file, 'x\n');
  const result = postEdit(cwd, file);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('post-edit skips factory artifacts', (t) => {
  const cwd = factory(t);
  configure(cwd, (config) => {
    config.commands.format = 'echo formatted >> {file}';
  });
  const file = path.join(cwd, '.sdlc', 'notes.md');
  fs.writeFileSync(file, 'x\n');
  postEdit(cwd, file);
  assert.equal(fs.readFileSync(file, 'utf8'), 'x\n');
});

test('post-edit reports a formatter failure without blocking', (t) => {
  const cwd = factory(t);
  configure(cwd, (config) => {
    config.commands.format = 'echo broken >&2; exit 3';
  });
  const file = path.join(cwd, 'a.py');
  fs.writeFileSync(file, 'x\n');
  const result = postEdit(cwd, file);
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.match(output.hookSpecificOutput.additionalContext, /formatter failed on a\.py: broken/);
});

test('session-start lists open work and stays quiet without any', (t) => {
  const cwd = factory(t);
  assert.equal(hook('session-start', { cwd }).stdout, '');
  sdlc(cwd, 'new', 'feature');
  const { stdout } = hook('session-start', { cwd });
  assert.match(stdout, /0001-feature \(standard\) is at spec, next: write spec.md/);
});

test('hooks.json wires every event and doesn\'t fail closed outside the factory', () => {
  const { hooks } = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  const args = (entry) => entry.hooks[0].args[1];
  assert.equal(args(hooks.SessionStart[0]), 'session-start');
  assert.deepEqual(hooks.PreToolUse.map(args), ['pre-edit', 'pre-bash']);
  assert.equal(args(hooks.PostToolUse[0]), 'post-edit');
  assert.equal(hooks.Stop[0].hooks[0].asyncRewake, true);
  // onFailure: block here would stop every edit in every repo on a machine with no Node.
  for (const entry of [...hooks.PreToolUse, ...hooks.PostToolUse, ...hooks.SessionStart]) {
    assert.equal(entry.hooks[0].onFailure, undefined);
  }
});
