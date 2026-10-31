'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');

const { parseLog, summarize } = require('../plugins/sdlc/lib/metrics');

const CLI = path.join(__dirname, '..', 'plugins', 'sdlc', 'bin', 'sdlc');
const TESTS = ['tests/**'];

function commit(date, subject, files = []) {
  return { date, subject, files };
}

function file(filePath, lines = 1) {
  return { path: filePath, lines };
}

describe('parseLog', () => {
  const record = (header, ...rows) => `\0${header}\n\n${rows.join('\n')}\n`;

  test('reads the date, subject, and files', () => {
    const output = record('2026-08-17T10:00:00-04:00\x1fAdd a thing', '3\t1\tsrc/a.py', '2\t0\tb.py');
    assert.deepEqual(parseLog(output), [
      {
        date: '2026-08-17T10:00:00-04:00',
        subject: 'Add a thing',
        files: [{ lines: 4, path: 'src/a.py' }, { lines: 2, path: 'b.py' }],
      },
    ]);
  });

  test('a binary file counts as a file with no lines', () => {
    const [parsed] = parseLog(record('2026-08-17T10:00:00-04:00\x1fData', '-\t-\tcatalog/a.parquet'));
    assert.deepEqual(parsed.files, [{ lines: 0, path: 'catalog/a.parquet' }]);
  });

  test('keeps a tab in a file name', () => {
    const [parsed] = parseLog(record('2026-08-17T10:00:00-04:00\x1fOdd', '1\t0\ta\tb.py'));
    assert.equal(parsed.files[0].path, 'a\tb.py');
  });

  test('handles a commit with no file changes', () => {
    assert.deepEqual(parseLog('\x002026-08-17T10:00:00-04:00\x1fEmpty\n')[0].files, []);
  });

  test('empty output means no commits', () => {
    assert.deepEqual(parseLog(''), []);
  });
});

describe('summarize', () => {
  test('counts days in the period and the active ones', () => {
    const { period, commits } = summarize(
      [
        commit('2026-08-17T09:00:00-04:00', 'a'),
        commit('2026-08-17T10:00:00-04:00', 'b'),
        commit('2026-08-20T10:00:00-04:00', 'c'),
      ],
      TESTS,
    );
    assert.deepEqual(period, { first: '2026-08-17', last: '2026-08-20', span_days: 4, active_days: 2 });
    assert.equal(commits.total, 3);
    assert.equal(commits.per_active_day, 1.5);
  });

  test('order of the log doesn\'t matter', () => {
    const newestFirst = summarize(
      [commit('2026-08-20T10:00:00-04:00', 'c'), commit('2026-08-17T10:00:00-04:00', 'a')],
      TESTS,
    );
    assert.equal(newestFirst.period.first, '2026-08-17');
    assert.equal(newestFirst.period.span_days, 4);
  });

  test('a late-night commit stays on its own local day', () => {
    const { period } = summarize([commit('2026-08-17T23:30:00-04:00', 'a')], TESTS);
    assert.equal(period.first, '2026-08-17');
  });

  test('a single day spans one day', () => {
    const { period } = summarize([commit('2026-08-17T10:00:00-04:00', 'a')], TESTS);
    assert.equal(period.span_days, 1);
  });

  test('medians work for odd and even counts', () => {
    const at = '2026-08-17T10:00:00-04:00';
    const odd = summarize(
      [commit(at, 'a', [file('a', 1)]), commit(at, 'b', [file('b', 9)]), commit(at, 'c', [file('c', 100)])],
      TESTS,
    );
    assert.equal(odd.size.median_lines, 9);
    assert.equal(odd.size.max_lines, 100);
    const even = summarize([commit(at, 'a', [file('a', 2)]), commit(at, 'b', [file('b', 4)])], TESTS);
    assert.equal(even.size.median_lines, 3);
  });

  test('lines sum across a commit\'s files', () => {
    const at = '2026-08-17T10:00:00-04:00';
    const { size } = summarize([commit(at, 'a', [file('a', 2), file('b', 3)])], TESTS);
    assert.equal(size.median_lines, 5);
    assert.equal(size.median_files, 2);
  });

  test('fix commits are matched on whole words', () => {
    const at = '2026-08-17T10:00:00-04:00';
    const subjects = ['Fix a gap', 'fixes login', 'Hotfix the build', 'Add a prefix option', 'Debug output', 'Fixture data'];
    const { signals } = summarize(subjects.map((subject) => commit(at, subject)), TESTS);
    assert.equal(signals.fix_commits, 3);
    assert.equal(signals.fix_share, 0.5);
  });

  test('reverts are counted from the start of the subject', () => {
    const at = '2026-08-17T10:00:00-04:00';
    const { signals } = summarize([commit(at, 'Revert "x"'), commit(at, 'Do not revert this')], TESTS);
    assert.equal(signals.reverts, 1);
  });

  test('commits touching tests use the given globs', () => {
    const at = '2026-08-17T10:00:00-04:00';
    const { signals } = summarize(
      [commit(at, 'a', [file('tests/test_a.py')]), commit(at, 'b', [file('src/a.py')])],
      TESTS,
    );
    assert.equal(signals.touching_tests, 1);
    assert.equal(signals.touching_tests_share, 0.5);
  });

  test('no commits gives zeros, not NaN', () => {
    const summary = summarize([], TESTS);
    assert.equal(summary.commits.total, 0);
    assert.equal(summary.commits.per_active_day, 0);
    assert.equal(summary.period.first, null);
    assert.equal(summary.period.span_days, 0);
    assert.equal(summary.size.max_lines, 0);
    assert.equal(summary.signals.fix_share, 0);
  });
});

describe('sdlc metrics', () => {
  const env = () => ({ ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' });

  function tempDir(t) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-metrics-')));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  function git(cwd, args, date) {
    const dates = date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {};
    execFileSync('git', args, { cwd, env: { ...env(), ...dates }, stdio: 'ignore' });
  }

  function repo(t) {
    const dir = tempDir(t);
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.name', 'Ada']);
    git(dir, ['config', 'user.email', 'ada@example.com']);
    return dir;
  }

  function change(cwd, name, subject, date) {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    fs.appendFileSync(path.join(cwd, name), 'line\n');
    git(cwd, ['add', '-A']);
    git(cwd, ['commit', '-q', '-m', subject], date);
  }

  function run(cwd, ...args) {
    return spawnSync(CLI, ['metrics', ...args], { cwd, encoding: 'utf8', env: env() });
  }

  test('a bare --since date keeps the whole of that day', (t) => {
    const cwd = repo(t);
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    change(cwd, 'a.py', 'Add a', `${today}T00:00:01`);
    const summary = JSON.parse(run(cwd, '--json', '--since', today).stdout);
    assert.equal(summary.commits.total, 1);
  });

  function workItem(cwd, id, stage, history) {
    const dir = path.join(cwd, '.sdlc', 'work', id);
    fs.mkdirSync(dir, { recursive: true });
    const state = { track: 'standard', stage, branch: 'main', rework: 0, history };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  }

  test('counts human approvals per finished item', (t) => {
    const cwd = repo(t);
    fs.mkdirSync(path.join(cwd, '.sdlc'));
    fs.writeFileSync(path.join(cwd, '.sdlc', 'config.json'), JSON.stringify({ version: 1, commands: {}, tracks: { critical: { paths: [] }, quick: { max_files: 3 } }, protected: [], tests: ['tests/**'], limits: { rework: 3 } }));
    change(cwd, 'a.py', 'Add a', '2026-08-17T10:00:00-04:00');
    const at = '2026-10-31T12:00:00Z';
    workItem(cwd, '0001-a', 'done', [{ at, approved: 'spec' }, { at, approved: 'merge' }, { at, from: 'merge', to: 'done' }]);
    workItem(cwd, '0002-b', 'done', [{ at, approved: 'spec' }, { at, from: 'merge', to: 'done' }]);
    workItem(cwd, '0003-c', 'build', [{ at, approved: 'spec' }]);

    const { approvals } = JSON.parse(run(cwd, '--json').stdout);
    assert.deepEqual(approvals, { items: 2, total: 3, per_item: 1.5 });
    const later = JSON.parse(run(cwd, '--json', '--since', '2026-11-01').stdout);
    assert.equal(later.approvals.items, 0);
  });

  test('works from a subfolder of a repo that doesn\'t use the factory', (t) => {
    const cwd = repo(t);
    change(cwd, 'src/a.py', 'Add a', '2026-08-17T10:00:00-04:00');
    change(cwd, 'tests/test_a.py', 'Fix a', '2026-08-19T10:00:00-04:00');
    const result = run(path.join(cwd, 'src'), '--json');
    assert.equal(result.status, 0, result.stderr);
    const metrics = JSON.parse(result.stdout);
    assert.equal(metrics.commits.total, 2);
    assert.equal(metrics.period.span_days, 3);
    assert.equal(metrics.signals.fix_commits, 1);
    assert.equal(metrics.signals.touching_tests, 1);
  });

  test('skips merge commits', (t) => {
    const cwd = repo(t);
    change(cwd, 'a.py', 'First', '2026-08-17T10:00:00-04:00');
    git(cwd, ['switch', '-q', '-c', 'side']);
    change(cwd, 'b.py', 'Side', '2026-08-18T10:00:00-04:00');
    git(cwd, ['switch', '-q', 'main']);
    change(cwd, 'c.py', 'Main', '2026-08-19T10:00:00-04:00');
    git(cwd, ['merge', '-q', '--no-ff', '-m', 'Merge side', 'side'], '2026-08-20T10:00:00-04:00');
    assert.equal(JSON.parse(run(cwd, '--json').stdout).commits.total, 3);
  });

  test('--since limits the window', (t) => {
    const cwd = repo(t);
    change(cwd, 'a.py', 'Old', '2026-01-01T10:00:00-04:00');
    change(cwd, 'b.py', 'New', '2026-08-19T10:00:00-04:00');
    assert.equal(JSON.parse(run(cwd, '--json', '--since', '2026-06-01').stdout).commits.total, 1);
  });

  test('--since can\'t smuggle a git option', (t) => {
    const cwd = repo(t);
    change(cwd, 'a.py', 'First', '2026-08-17T10:00:00-04:00');
    const result = run(cwd, '--json', '--since=--output=stolen.txt');
    assert.equal(fs.existsSync(path.join(cwd, 'stolen.txt')), false);
    assert.equal(result.status, 0);
  });

  test('the output names no commits or paths', (t) => {
    const cwd = repo(t);
    change(cwd, 'secret-project/plan.py', 'Private subject line', '2026-08-17T10:00:00-04:00');
    const { stdout } = run(cwd, '--json');
    assert.doesNotMatch(stdout, /secret-project|Private subject|sdlc-metrics-/);
  });

  test('human output reads as a summary', (t) => {
    const cwd = repo(t);
    change(cwd, 'a.py', 'Add a', '2026-08-17T10:00:00-04:00');
    assert.match(run(cwd).stdout, /1 commits over 1 days/);
  });

  test('refuses outside a repository', (t) => {
    const result = run(tempDir(t));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /repository with commits/);
  });

  test('refuses a repository with no commits', (t) => {
    assert.equal(run(repo(t)).status, 1);
  });

  test('changes nothing on disk', (t) => {
    const cwd = repo(t);
    change(cwd, 'a.py', 'First', '2026-08-17T10:00:00-04:00');
    run(cwd);
    const status = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', env: env() });
    assert.equal(status, '');
    assert.equal(fs.existsSync(path.join(cwd, '.sdlc')), false);
  });
});
