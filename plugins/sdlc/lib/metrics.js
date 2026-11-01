'use strict';

// Delivery metrics from Git history alone, so a repo can be measured before it
// adopts the factory and compared on the same fields afterward. The output is
// aggregates only: no commit subjects or paths, so it's safe to publish.

const { execFileSync } = require('node:child_process');

const { matchesAny } = require('./machine');
const { SdlcError, listIds, loadConfig, loadItem } = require('./workspace');

const RECORD = '\0';
const FIELD = '\x1f';
const DAY_MS = 86400000;

const FIX_SUBJECT = /\b(fix|fixes|fixed|fixing|bug|bugfix|hotfix|regression)\b/i;
const REVERT_SUBJECT = /^revert\b/i;

function git(root, args) {
  try {
    const options = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 };
    return execFileSync('git', args, options);
  } catch {
    throw new SdlcError(`git ${args[0]} failed: is this a repository with commits?`);
  }
}

function repoRoot(cwd) {
  return git(cwd, ['rev-parse', '--show-toplevel']).trim();
}

// Binary files report "-" for their line counts, so they count as a changed file
// with no lines.
function parseFile(line) {
  const [added, deleted, ...path] = line.split('\t');
  return { lines: (Number(added) || 0) + (Number(deleted) || 0), path: path.join('\t') };
}

function parseLog(output) {
  return output
    .split(RECORD)
    .filter(Boolean)
    .map((record) => {
      const [header, ...rows] = record.split('\n');
      const [date, subject] = header.split(FIELD);
      const files = rows.filter(Boolean).map(parseFile);
      return { date, subject, files };
    });
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function share(part, total) {
  return total === 0 ? 0 : round(part / total);
}

// The date is read as written, in the author's own time zone, so a late-night
// commit isn't moved to the next day.
function summarize(commits, testGlobs) {
  const days = commits.map((commit) => commit.date.slice(0, 10)).sort();
  const lines = commits.map((commit) => commit.files.reduce((sum, file) => sum + file.lines, 0));
  const activeDays = new Set(days).size;
  const fixes = commits.filter((commit) => FIX_SUBJECT.test(commit.subject)).length;
  const reverts = commits.filter((commit) => REVERT_SUBJECT.test(commit.subject)).length;
  const touchingTests = commits.filter((commit) =>
    commit.files.some((file) => matchesAny(file.path, testGlobs)),
  ).length;
  const first = days[0] ?? null;
  const last = days.at(-1) ?? null;
  return {
    period: {
      first,
      last,
      span_days: first ? (Date.parse(last) - Date.parse(first)) / DAY_MS + 1 : 0,
      active_days: activeDays,
    },
    commits: {
      total: commits.length,
      per_active_day: share(commits.length, activeDays),
    },
    size: {
      median_files: median(commits.map((commit) => commit.files.length)),
      median_lines: median(lines),
      max_lines: Math.max(0, ...lines),
    },
    signals: {
      fix_commits: fixes,
      fix_share: share(fixes, commits.length),
      reverts,
      touching_tests: touchingTests,
      touching_tests_share: share(touchingTests, commits.length),
    },
  };
}

// Git reads a bare date as that date at the current time of day, which drops most
// of the day it names.
function sinceArg(since) {
  return /^\d{4}-\d{2}-\d{2}$/.test(since) ? `${since}T00:00:00` : since;
}

// Human approvals per finished item, from the items' own history. Dates compare as
// text, which works because both are ISO.
function approvals(root, since) {
  const finished = listIds(root)
    .map((id) => loadItem(root, id))
    .filter((item) => item.stage === 'done')
    .filter((item) => !since || (item.history.at(-1)?.at ?? '') >= since);
  const total = finished.flatMap((item) => item.history).filter((event) => event.approved).length;
  return { items: finished.length, total, per_item: share(total, finished.length) };
}

function collect(cwd, since) {
  const root = repoRoot(cwd);
  const args = ['log', '--no-merges', '--no-renames', '--numstat', '--format=%x00%aI%x1f%s'];
  if (since) args.push(`--since=${sinceArg(since)}`);
  const summary = summarize(parseLog(git(root, args)), loadConfig(root).tests);
  return { ...summary, approvals: approvals(root, since) };
}

module.exports = { collect, parseLog, summarize };
