'use strict';

// Detection is plain code over CI run data, so a model can't miss a breach or
// talk itself out of one. The input is `gh run list --json` output, which keeps
// this testable and leaves fetching to the workflow.

const FINISHED = new Set(['success', 'failure', 'timed_out', 'startup_failure']);
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

// Most recent first. Cancelled and skipped runs say nothing about health.
function recentRuns(runs, workflow, branch, window) {
  return runs
    .filter((run) => run.workflowName === workflow && run.headBranch === branch)
    .filter((run) => FINISHED.has(run.conclusion))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, window);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function checkWorkflow(runs, workflow, branch, band) {
  const recent = recentRuns(runs, workflow, branch, band.window);
  if (recent.length < band.min_runs) return null;
  const failed = recent.filter((run) => FAILED.has(run.conclusion));
  const rate = round(failed.length / recent.length);
  if (rate <= band.max) return null;
  return {
    metric: 'ci_failure_rate',
    workflow,
    branch,
    rate,
    max: band.max,
    failed: failed.length,
    runs: recent.length,
    examples: failed.slice(0, 5).map((run) => ({ title: run.displayTitle, url: run.url })),
  };
}

function detect(runs, branch, bands) {
  const band = bands.ci_failure_rate;
  const workflows = [...new Set(runs.map((run) => run.workflowName))].sort();
  return workflows.map((name) => checkWorkflow(runs, name, branch, band)).filter(Boolean);
}

// Which workflows had enough runs to judge. With none, a quiet result means nothing,
// so callers must say that rather than report good health.
function coverage(runs, branch, bands) {
  const band = bands.ci_failure_rate;
  const workflows = [...new Set(runs.map((run) => run.workflowName))].sort();
  return workflows.filter((name) => recentRuns(runs, name, branch, band.window).length >= band.min_runs);
}

function slugFor(breach) {
  const name = breach.workflow.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `breach-${name || 'ci'}`;
}

function intentFor(breach) {
  const percent = (value) => `${Math.round(value * 100)}%`;
  const examples = breach.examples.map((run) => `- [${run.title}](${run.url})`).join('\n');
  return `# Intent: fix failures in ${breach.workflow}

Written by \`sdlc breach\`, with no person involved. Check it before approving.

## Problem

\`${breach.workflow}\` failed ${breach.failed} of its last ${breach.runs} runs on \`${breach.branch}\`. That's ${percent(breach.rate)}, over the limit of ${percent(breach.max)}.

## Failed runs

${examples}

## Proposed outcome

Find out why these runs fail, then fix the cause. The failure rate should come back under the limit.

## Unknown

The cause. Nothing here has been diagnosed yet.
`;
}

module.exports = { coverage, detect, intentFor, slugFor };
