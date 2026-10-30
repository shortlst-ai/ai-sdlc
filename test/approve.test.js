'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const PLUGIN = path.join(__dirname, '..', 'plugins', 'sdlc');
const CLI = path.join(PLUGIN, 'bin', 'sdlc');
const HOOK = path.join(PLUGIN, 'scripts', 'on-approve.js');
const ID = '0001-feature';

// Ignores the machine's own git identity, and any attended flag from the session
// running these tests.
function env(extra = {}) {
  const { CLAUDE_CODE_SESSION_ATTENDED, ...rest } = process.env;
  return { ...rest, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', ...extra };
}

function sdlc(args, cwd) {
  return spawnSync(CLI, args, { cwd, encoding: 'utf8', env: env() });
}

function hook(cwd, { args = '', extraEnv } = {}) {
  const input = JSON.stringify({ cwd, command_name: 'sdlc:approve', command_args: args });
  const result = spawnSync('node', [HOOK], { input, encoding: 'utf8', env: env(extraEnv) });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, env: env() });
}

function repo(t, { identity = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-approve-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q');
  if (identity) {
    git(dir, 'config', 'user.name', 'Ada Reviewer');
    git(dir, 'config', 'user.email', 'ada@example.com');
  }
  assert.equal(sdlc(['init'], dir).status, 0);
  assert.equal(sdlc(['new', 'feature'], dir).status, 0);
  return dir;
}

function itemPath(cwd, ...parts) {
  return path.join(cwd, '.sdlc', 'work', ID, ...parts);
}

function writeSpec(cwd, content = 'the spec') {
  fs.writeFileSync(itemPath(cwd, 'spec.md'), content);
}

function readItem(cwd) {
  return JSON.parse(fs.readFileSync(itemPath(cwd, 'state.json'), 'utf8'));
}

function nextAction(cwd) {
  return JSON.parse(sdlc(['status', '--json'], cwd).stdout).next;
}

test('records the stage, hash, and approver, and opens the gate', (t) => {
  const cwd = repo(t);
  writeSpec(cwd);
  const output = hook(cwd);
  assert.match(output.hookSpecificOutput.additionalContext, /^Approval recorded: 0001-feature spec/);
  assert.equal(output.decision, undefined);

  const record = JSON.parse(fs.readFileSync(itemPath(cwd, 'approvals', 'spec.json'), 'utf8'));
  assert.equal(record.stage, 'spec');
  assert.equal(record.artifact, 'spec.md');
  assert.match(record.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(record.approver, { name: 'Ada Reviewer', email: 'ada@example.com' });

  assert.equal(sdlc(['advance'], cwd).status, 0);
  assert.equal(readItem(cwd).stage, 'plan');
});

test('editing an approved artifact reopens its gate until it is approved again', (t) => {
  const cwd = repo(t);
  writeSpec(cwd);
  hook(cwd);
  sdlc(['advance'], cwd);

  writeSpec(cwd, 'quietly changed');
  assert.equal(nextAction(cwd).stale, true);
  assert.equal(sdlc(['advance'], cwd).status, 1);

  assert.equal(hook(cwd).decision, undefined);
  assert.equal(nextAction(cwd).action, 'produce');
  const approvals = readItem(cwd).history.filter((event) => event.approved);
  assert.equal(approvals.length, 2);
  assert.notEqual(approvals[0].sha256, approvals[1].sha256);
});

test('refuses when nothing is waiting on approval', (t) => {
  const cwd = repo(t);
  const output = hook(cwd);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /Not approved: .*write spec.md/);
  assert.equal(fs.existsSync(itemPath(cwd, 'approvals')), false);
});

test('refuses in an unattended session, so an agent can\'t use claude -p', (t) => {
  const cwd = repo(t);
  writeSpec(cwd);
  const output = hook(cwd, { extraEnv: { CLAUDE_CODE_SESSION_ATTENDED: '0' } });
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /unattended/);
  assert.equal(fs.existsSync(itemPath(cwd, 'approvals')), false);
});

test('an attended flag of 1 or a missing flag both work', (t) => {
  const attended = repo(t);
  writeSpec(attended);
  const output = hook(attended, { extraEnv: { CLAUDE_CODE_SESSION_ATTENDED: '1' } });
  assert.equal(output.decision, undefined);

  const unset = repo(t);
  writeSpec(unset);
  assert.equal(hook(unset).decision, undefined);
});

test('refuses without a git identity, because an approval must name a person', (t) => {
  const cwd = repo(t, { identity: false });
  writeSpec(cwd);
  const output = hook(cwd);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /user\.name/);
  assert.equal(fs.existsSync(itemPath(cwd, 'approvals')), false);
});

test('refuses outside the factory', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-approve-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.match(hook(dir).reason, /does not use the factory/);
});

test('with several open items, the id picks one and is required', (t) => {
  const cwd = repo(t);
  sdlc(['new', 'other'], cwd);
  writeSpec(cwd);
  assert.match(hook(cwd).reason, /several open work items/);
  assert.equal(hook(cwd, { args: '1' }).decision, undefined);
  assert.equal(readItem(cwd).history.at(-1).approved, 'spec');
});

test('the CLI has no way to approve', (t) => {
  const cwd = repo(t);
  writeSpec(cwd);
  assert.equal(sdlc(['approve'], cwd).status, 2);
  assert.equal(fs.existsSync(itemPath(cwd, 'approvals')), false);
});

test('the skill can\'t be invoked by the model', () => {
  const skill = fs.readFileSync(path.join(PLUGIN, 'skills', 'approve', 'SKILL.md'), 'utf8');
  assert.match(skill, /^disable-model-invocation: true$/m);
});

test('the hook is wired to the skill and fails closed', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  const [entry] = hooks.hooks.UserPromptExpansion;
  assert.equal(entry.matcher, 'sdlc:approve');
  assert.equal(entry.hooks[0].onFailure, 'block');
});
