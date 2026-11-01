'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');

const { detect, intentFor, slugFor } = require('../plugins/sdlc/lib/detect');

const PLUGIN = path.join(__dirname, '..', 'plugins', 'sdlc');
const CLI = path.join(PLUGIN, 'bin', 'sdlc');
const BANDS = { ci_failure_rate: { max: 0.25, window: 4, min_runs: 3 } };

function run(conclusion, day, extra = {}) {
  return {
    workflowName: 'ci',
    headBranch: 'main',
    conclusion,
    createdAt: `2026-10-${String(day).padStart(2, '0')}T10:00:00Z`,
    displayTitle: `run ${day}`,
    url: `https://example.invalid/${day}`,
    ...extra,
  };
}

const series = (...conclusions) => conclusions.map((value, index) => run(value, index + 1));

describe('detect', () => {
  test('stays quiet within the limit', () => {
    assert.deepEqual(detect(series('failure', 'success', 'success', 'success'), 'main', BANDS), []);
  });

  test('reports a workflow over the limit, with its evidence', () => {
    const [breach] = detect(series('failure', 'failure', 'success', 'success'), 'main', BANDS);
    assert.equal(breach.rate, 0.5);
    assert.equal(breach.failed, 2);
    assert.equal(breach.runs, 4);
    assert.deepEqual(breach.examples.map((item) => item.title), ['run 2', 'run 1']);
  });

  test('exactly at the limit is not a breach', () => {
    assert.deepEqual(detect(series('failure', 'success', 'success', 'success'), 'main', BANDS), []);
  });

  test('only the most recent runs count, so a fixed problem clears', () => {
    const runs = series('failure', 'failure', 'failure', 'success', 'success', 'success', 'success');
    assert.deepEqual(detect(runs, 'main', BANDS), []);
  });

  test('too few runs says nothing', () => {
    assert.deepEqual(detect(series('failure', 'failure'), 'main', BANDS), []);
  });

  test('pull request runs don\'t count, so a deliberate failure can\'t raise an alarm', () => {
    const runs = [
      ...series('success', 'success', 'success'),
      run('failure', 20, { headBranch: 'attack' }),
      run('failure', 21, { headBranch: 'attack' }),
    ];
    assert.deepEqual(detect(runs, 'main', BANDS), []);
  });

  test('cancelled and skipped runs say nothing about health', () => {
    const runs = series('success', 'success', 'success', 'cancelled', 'skipped', 'cancelled');
    assert.deepEqual(detect(runs, 'main', BANDS), []);
    assert.deepEqual(detect(series('cancelled', 'cancelled', 'cancelled'), 'main', BANDS), []);
  });

  test('timeouts count as failures', () => {
    const runs = series('timed_out', 'startup_failure', 'success', 'success');
    assert.equal(detect(runs, 'main', BANDS)[0].failed, 2);
  });

  test('each workflow is judged alone', () => {
    const runs = [
      ...series('failure', 'failure', 'failure'),
      ...series('success', 'success', 'success').map((item) => ({ ...item, workflowName: 'other' })),
    ];
    assert.deepEqual(detect(runs, 'main', BANDS).map((item) => item.workflow), ['ci']);
  });

  test('the order of the input doesn\'t matter', () => {
    const runs = series('failure', 'failure', 'success', 'success', 'success', 'success').reverse();
    assert.deepEqual(detect(runs, 'main', BANDS), []);
  });
});

describe('intent', () => {
  const breach = detect(series('failure', 'failure', 'success', 'success'), 'main', BANDS)[0];

  test('names the problem and links the runs', () => {
    const text = intentFor(breach);
    assert.match(text, /failed 2 of its last 4 runs on `main`/);
    assert.match(text, /50%, over the limit of 25%/);
    assert.match(text, /\[run 2\]\(https:\/\/example\.invalid\/2\)/);
  });

  test('a workflow name becomes a valid slug', () => {
    assert.equal(slugFor({ workflow: 'Build & Test / Linux' }), 'breach-build-test-linux');
    assert.equal(slugFor({ workflow: '***' }), 'breach-ci');
  });
});

describe('the commands', () => {
  function repo(t) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-detect-')));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Ada');
    git('config', 'user.email', 'ada@example.com');
    git('commit', '-q', '--allow-empty', '-m', 'first');
    sdlc(dir, 'init');
    return dir;
  }

  function sdlc(cwd, ...args) {
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
    return spawnSync(CLI, args, { cwd, encoding: 'utf8', env });
  }

  function runsFile(cwd, runs) {
    const file = path.join(cwd, 'runs.json');
    fs.writeFileSync(file, JSON.stringify(runs));
    return file;
  }

  const bad = () => series('failure', 'failure', 'failure', 'failure', 'failure', 'failure');

  test('detect reports without changing anything', (t) => {
    const cwd = repo(t);
    const result = sdlc(cwd, 'detect', '--runs', runsFile(cwd, bad()), '--branch', 'main', '--json');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).breaches[0].workflow, 'ci');
    assert.deepEqual(fs.readdirSync(path.join(cwd, '.sdlc', 'work')), []);
  });

  test('no data is reported as no data, never as good health', (t) => {
    const cwd = repo(t);
    const otherBranch = series('success', 'success', 'success', 'success', 'success').map((item) => ({
      ...item,
      headBranch: 'feature',
    }));
    const file = runsFile(cwd, otherBranch);
    const output = sdlc(cwd, 'detect', '--runs', file, '--branch', 'main').stdout;
    assert.match(output, /Nothing to judge/);
    assert.doesNotMatch(output, /Within limits/);
    assert.deepEqual(JSON.parse(sdlc(cwd, 'detect', '--runs', file, '--branch', 'main', '--json').stdout).checked, []);
  });

  test('breach opens an item at the intent gate, on the critical track', (t) => {
    const cwd = repo(t);
    const result = sdlc(cwd, 'breach', '--runs', runsFile(cwd, bad()), '--branch', 'main', '--json');
    assert.deepEqual(JSON.parse(result.stdout), { created: ['0001-breach-ci'] });

    const dir = path.join(cwd, '.sdlc', 'work', '0001-breach-ci');
    assert.match(fs.readFileSync(path.join(dir, 'intent.md'), 'utf8'), /failed 6 of its last 6 runs/);
    const [item] = JSON.parse(sdlc(cwd, 'status', '--json').stdout).items;
    assert.equal(item.track, 'critical');
    assert.equal(item.stage, 'intent');
    assert.deepEqual(item.next, { action: 'approve', stage: 'intent', artifact: 'intent.md' });
  });

  test('a breach that is already open isn\'t opened twice', (t) => {
    const cwd = repo(t);
    const file = runsFile(cwd, bad());
    sdlc(cwd, 'breach', '--runs', file, '--branch', 'main');
    const result = sdlc(cwd, 'breach', '--runs', file, '--branch', 'main', '--json');
    assert.deepEqual(JSON.parse(result.stdout), { created: [] });
    assert.deepEqual(fs.readdirSync(path.join(cwd, '.sdlc', 'work')), ['0001-breach-ci']);
  });

  test('breach does nothing when CI is healthy', (t) => {
    const cwd = repo(t);
    const runs = series('success', 'success', 'success', 'success', 'success');
    const result = sdlc(cwd, 'breach', '--runs', runsFile(cwd, runs), '--branch', 'main');
    assert.match(result.stdout, /No new breaches/);
  });

  test('limits in the config apply, and a config without them uses the defaults', (t) => {
    const cwd = repo(t);
    const config = path.join(cwd, '.sdlc', 'config.json');
    const value = JSON.parse(fs.readFileSync(config, 'utf8'));
    value.bands.ci_failure_rate.max = 0.9;
    fs.writeFileSync(config, JSON.stringify(value));
    const file = runsFile(cwd, series('failure', 'failure', 'failure', 'failure', 'success', 'success'));
    assert.match(sdlc(cwd, 'detect', '--runs', file, '--branch', 'main').stdout, /Within limits: ci/);

    delete value.bands;
    fs.writeFileSync(config, JSON.stringify(value));
    assert.match(sdlc(cwd, 'detect', '--runs', file, '--branch', 'main').stdout, /4 of 6 runs failed/);
  });

  test('bad input is refused rather than read as healthy', (t) => {
    const cwd = repo(t);
    fs.writeFileSync(path.join(cwd, 'bad.json'), '{"not": "a list"}');
    assert.equal(sdlc(cwd, 'detect', '--runs', 'bad.json', '--branch', 'main').status, 1);
    assert.equal(sdlc(cwd, 'detect', '--runs', 'missing.json', '--branch', 'main').status, 1);
    assert.equal(sdlc(cwd, 'detect', '--branch', 'main').status, 2);
  });
});

describe('the monitor workflow', () => {
  const text = fs.readFileSync(path.join(PLUGIN, 'templates', 'sdlc-monitor.yml'), 'utf8');

  test('runs by itself and can be started by hand', () => {
    assert.match(text, /schedule:/);
    assert.match(text, /workflow_dispatch:/);
  });

  test('never merges or approves anything', () => {
    assert.doesNotMatch(text, /gh pr merge/);
    assert.doesNotMatch(text.replace(/`\/sdlc:approve`/, ''), /sdlc:approve/);
  });

  test('won\'t pile up pull requests', () => {
    assert.match(text, /gh pr list --label sdlc-breach --state open/);
  });

  test('never runs code from a pull request', () => {
    assert.doesNotMatch(text, /pull_request/);
  });

  test('still works with no API key', () => {
    assert.match(text, /env\.ANTHROPIC_API_KEY != ''/);
    assert.match(text, /continue-on-error: true/);
  });
});
