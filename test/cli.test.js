'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const CLI = path.join(__dirname, '..', 'plugins', 'sdlc', 'bin', 'sdlc');

function run(args, cwd = os.tmpdir()) {
  return spawnSync(CLI, args, { cwd, encoding: 'utf8' });
}

function tempRepo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-test-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('prints the version from plugin.json', () => {
  const manifest = path.join(CLI, '..', '..', '.claude-plugin', 'plugin.json');
  const { version } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const result = run(['--version']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), version);
});

test('status reports a repo without the factory', (t) => {
  const result = run(['status', '--json'], tempRepo(t));
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { initialized: false, root: null });
});

test('status finds .sdlc from a subfolder', (t) => {
  const root = tempRepo(t);
  fs.mkdirSync(path.join(root, '.sdlc'));
  const nested = path.join(root, 'src', 'deep');
  fs.mkdirSync(nested, { recursive: true });
  const result = run(['status', '--json'], nested);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { initialized: true, root });
});

test('an unknown command fails with usage on stderr', () => {
  const result = run(['nope']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command 'nope'/);
  assert.equal(result.stdout, '');
});
