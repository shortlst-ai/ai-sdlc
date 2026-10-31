'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');

const PLUGIN = path.join(__dirname, '..', 'plugins', 'sdlc');
const CLI = path.join(PLUGIN, 'bin', 'sdlc');

function agent(name) {
  const text = fs.readFileSync(path.join(PLUGIN, 'agents', `${name}.md`), 'utf8');
  const [, front, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  const field = (key) => new RegExp(`^${key}: (.*)$`, 'm').exec(front)?.[1];
  return { body, name: field('name'), tools: field('tools')?.split(', ') ?? [], model: field('model') };
}

function skills() {
  return fs.readdirSync(path.join(PLUGIN, 'skills'));
}

function skill(name) {
  return fs.readFileSync(path.join(PLUGIN, 'skills', name, 'SKILL.md'), 'utf8');
}

describe('agents', () => {
  const names = fs.readdirSync(path.join(PLUGIN, 'agents')).map((file) => file.replace('.md', ''));

  test('the roles the hooks know about exist', () => {
    for (const role of ['researcher', 'spec-writer', 'planner', 'builder', 'verifier', 'reviewer']) {
      assert.ok(names.includes(role), role);
    }
  });

  for (const name of names) {
    test(`${name} is named after its file and picks a model alias`, () => {
      assert.equal(agent(name).name, name);
      assert.match(agent(name).model, /^(haiku|sonnet|opus)$/);
    });
  }

  test('read-only roles have no way to change anything', () => {
    for (const name of ['researcher', 'reviewer']) {
      const { tools } = agent(name);
      for (const tool of ['Write', 'Edit', 'Bash', 'NotebookEdit']) {
        assert.ok(!tools.includes(tool), `${name} has ${tool}`);
      }
    }
  });

  test('writers without Bash can\'t reach around the path rules', () => {
    for (const name of ['spec-writer', 'planner']) assert.ok(!agent(name).tools.includes('Bash'), name);
  });

  test('no agent relies on frontmatter a plugin or teammate ignores', () => {
    for (const name of names) {
      const front = fs.readFileSync(path.join(PLUGIN, 'agents', `${name}.md`), 'utf8').split('---')[1];
      assert.doesNotMatch(front, /^(hooks|mcpServers|permissionMode|skills):/m, name);
    }
  });
});

describe('skills', () => {
  test('each has a description', () => {
    for (const name of skills()) assert.match(skill(name), /^description: \S/m, name);
  });

  test('every skill the orchestrator names exists', () => {
    const named = [...skill('next').matchAll(/`\/sdlc:([a-z]+)`/g)].map((match) => match[1]);
    for (const name of named) assert.ok(skills().includes(name), name);
  });

  test('every skill that spawns a role explains how, and that role exists', () => {
    const roles = fs.readdirSync(path.join(PLUGIN, 'agents')).map((file) => file.replace('.md', ''));
    for (const name of skills()) {
      for (const [, role] of skill(name).matchAll(/`sdlc:([a-z-]+)`/g)) {
        if (name !== 'team' && !['approve', 'abandon', 'next', 'new'].includes(role)) {
          assert.ok(roles.includes(role), `${name} names ${role}`);
        }
      }
    }
  });

  test('human decisions are never model-invocable', () => {
    for (const name of ['approve', 'abandon', 'init']) {
      assert.match(skill(name), /^disable-model-invocation: true$/m, name);
    }
  });

  test('every sdlc command a skill runs exists', () => {
    const usage = spawnSync(CLI, ['--help'], { encoding: 'utf8' }).stdout;
    const known = new Set([...usage.matchAll(/^ {2}([a-z]+)/gm)].map((match) => match[1]));
    for (const name of skills()) {
      for (const [, command] of skill(name).matchAll(/`sdlc ([a-z]+)/g)) {
        assert.ok(known.has(command), `${name} runs sdlc ${command}`);
      }
    }
  });

  test('every stage a session can reach has a skill', () => {
    const next = skill('next');
    const { ARTIFACTS } = require(path.join(PLUGIN, 'lib', 'machine'));
    for (const stage of Object.keys(ARTIFACTS)) assert.match(next, new RegExp(`\\b${stage}\\b`), stage);
    assert.ok(skills().includes('release'));
    assert.match(next, /`release` \| `\/sdlc:release`/);
  });

  test('neither release nor learn acts by itself', () => {
    assert.match(skill('release'), /You can't approve it/);
    assert.match(skill('learn'), /Don't change anything yourself/);
  });

  test('skills never tell the model to approve or merge', () => {
    const next = skill('next');
    assert.match(next, /You can't approve anything/);
    assert.match(next, /You don't run the merge/);
    assert.match(skill('ship'), /Never merge it yourself/);
  });
});

describe('sdlc init options', () => {
  function tempDir(t) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-init-')));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  function config(cwd) {
    return JSON.parse(fs.readFileSync(path.join(cwd, '.sdlc', 'config.json'), 'utf8'));
  }

  test('writes the commands and paths it\'s given', (t) => {
    const cwd = tempDir(t);
    const args = ['init', '--setup', 'make env', '--verify', 'make test', '--format', 'fmt {file}', '--critical', 'a/**,b/**', '--protected', 'gen/**'];
    assert.equal(spawnSync(CLI, args, { cwd, encoding: 'utf8' }).status, 0);
    const written = config(cwd);
    assert.deepEqual(written.commands, { setup: 'make env', verify: 'make test', format: 'fmt {file}' });
    assert.deepEqual(written.tracks.critical.paths, ['a/**', 'b/**']);
    assert.equal(written.tracks.quick.max_files, 3);
    assert.deepEqual(written.protected, ['gen/**']);
  });

  test('anything not given keeps its default', (t) => {
    const cwd = tempDir(t);
    spawnSync(CLI, ['init', '--verify', 'make test'], { cwd, encoding: 'utf8' });
    assert.deepEqual(config(cwd).commands, { setup: null, verify: 'make test', format: null });
  });
});

describe('sdlc changed', () => {
  test('lists nothing outside git', (t) => {
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-init-')));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    spawnSync(CLI, ['init'], { cwd });
    spawnSync(CLI, ['new', 'x'], { cwd });
    const result = spawnSync(CLI, ['changed'], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });
});
