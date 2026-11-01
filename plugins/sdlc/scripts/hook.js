#!/usr/bin/env node
'use strict';

// Hook handlers. Plugin hooks fire in every session, including repos that don't
// use the factory, so each one leaves at once when there's no .sdlc/ directory.

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { reviewBuild } = require('../lib/check');
const machine = require('../lib/machine');
const { checkCommand, checkEdit, roleOf } = require('../lib/policy');
const workspace = require('../lib/workspace');

function refuse(reason) {
  console.error(`sdlc: ${reason}`);
  process.exitCode = 2;
}

function openItems(root) {
  return workspace
    .ownItems(root)
    .filter(machine.isOpen)
    .map((item) => {
      const next = machine.nextAction(item, workspace.readFacts(root, item));
      return { item, next, describeNext: machine.describeNext(next) };
    });
}

// Resolves symlinks, so a link can't disguise a managed file. The real path gives
// the true case on macOS, where `.SDLC/` would otherwise reach `.sdlc/`. A new
// file doesn't exist yet, so its nearest existing folder is resolved instead.
function repoRelative(root, cwd, file) {
  const absolute = path.resolve(cwd, file);
  let existing = absolute;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const real = path.join(fs.realpathSync.native(existing), path.relative(existing, absolute));
  const relative = path.relative(fs.realpathSync.native(root), real);
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) return null;
  return relative.split(path.sep).join('/');
}

function preEdit(root, input) {
  const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (!target) return;
  const file = repoRelative(root, input.cwd, target);
  if (file === null) return;
  const decision = checkEdit({
    file,
    role: roleOf(input.agent_type, workspace.readTeam(input.session_id)),
    items: openItems(root),
    config: workspace.loadConfig(root),
  });
  if (!decision.allow) refuse(decision.reason);
}

function gitLines(root, args) {
  try {
    const options = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    return execFileSync('git', args, options).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function preBash(root, input) {
  const command = input.tool_input?.command;
  if (!command) return;
  const decision = checkCommand(command, {
    currentBranch: () => gitLines(root, ['rev-parse', '--abbrev-ref', 'HEAD'])[0],
    stagedFiles: () => gitLines(root, ['diff', '--cached', '--name-only']),
    changedFiles: () => gitLines(root, ['ls-files', '-mo', '--exclude-standard']),
  });
  if (!decision.allow) refuse(decision.reason);
}

// Never blocks: the edit already happened, so a failure is only reported. The
// file goes to the shell as an argument, because a file name can contain anything.
function postEdit(root, input) {
  const format = workspace.loadConfig(root).commands?.format;
  const target = input.tool_input?.file_path;
  if (!format || !target) return;
  const file = repoRelative(root, input.cwd, target);
  if (file === null || file.startsWith('.sdlc/') || !fs.existsSync(path.join(root, file))) return;
  const script = format.replaceAll('{file}', '"$1"');
  const result = spawnSync('sh', ['-c', script, 'sdlc-format', file], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
  });
  if (result.status === 0) return;
  const detail = (result.stderr || result.error?.message || '').trim().slice(0, 500);
  const context = `The formatter failed on ${file}: ${detail}`;
  console.log(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }),
  );
}

// Gives a builder its problems back as its next instruction, a limited number of
// times, then lets it stop so a person hears about it instead of it looping.
function subagentStop(root, input) {
  const role = roleOf(input.agent_type, workspace.readTeam(input.session_id));
  if (role !== 'builder') return;
  const [item] = workspace.ownItems(root).filter((entry) => entry.stage === 'build');
  if (!item) return;
  const config = workspace.loadConfig(root);
  const { problems } = reviewBuild(root, item, config);
  const command = config.commands?.verify;
  if (problems.length === 0 && command) {
    const result = spawnSync('sh', ['-c', command], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
    if (result.status !== 0) {
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd().split('\n').slice(-20).join('\n');
      problems.push(`\`${command}\` failed:\n${output}`);
    }
  }
  if (problems.length === 0) return;
  if (workspace.countStopBlock(root, input.agent_id) > config.limits.rework) {
    console.error(`sdlc: giving up on ${item.id} after repeated failures: ${problems.join('; ')}`);
    return;
  }
  console.log(JSON.stringify({ decision: 'block', reason: `Not finished. ${problems.join('; ')}` }));
}

function sessionStart(root) {
  if (workspace.setupPending(root)) {
    console.log('This worktree has no environment yet. Run `sdlc setup` before building or testing.');
  }
  const open = openItems(root);
  if (open.length === 0) return;
  console.log('Open sdlc work items:');
  for (const { item, describeNext } of open) {
    console.log(`- ${item.id} (${item.track}) is at ${item.stage}, next: ${describeNext}`);
  }
}

// A session sometimes ends its turn with work left and nobody needed. The CLI knows
// that, so it decides rather than the model. It nudges once per stop, and stays out
// of the way of running teammates, gates, and sessions nobody is watching. A missing
// task list means it can't tell, so it does nothing.
function stop(root, input) {
  if (process.env.CLAUDE_CODE_SESSION_ATTENDED === '0' || input.stop_hook_active) return;
  if (!Array.isArray(input.background_tasks) || input.background_tasks.length > 0) return;
  const open = openItems(root);
  if (open.length !== 1 || !['produce', 'advance'].includes(open[0].next.action)) return;
  const reason =
    `${open[0].item.id} still has work and doesn't need a person yet: ${open[0].describeNext}. ` +
    'Continue with /sdlc:next. If you stopped to ask the person something, say so and stop.';
  console.log(JSON.stringify({ decision: 'block', reason }));
}

const HANDLERS = {
  'pre-edit': preEdit,
  'pre-bash': preBash,
  'post-edit': postEdit,
  'subagent-stop': subagentStop,
  'session-start': sessionStart,
  stop,
};

function main() {
  const handler = HANDLERS[process.argv[2]];
  if (!handler) throw new Error(`unknown hook '${process.argv[2]}'`);
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const root = workspace.findRoot(input.cwd);
  if (!root) {
    if (process.argv[2] === 'session-start' && workspace.unreachableFactory(input.cwd)) {
      console.log(workspace.UNREACHABLE_WARNING);
    }
    return;
  }
  try {
    handler(root, input);
  } catch (error) {
    // Inside the factory, an unreadable state means the gates can't be checked,
    // so the safe answer is no. The format and session hooks have nothing to stop.
    if (process.argv[2].startsWith('pre-')) refuse(`can't check this action: ${error.message}`);
    else console.error(`sdlc: ${error.message}`);
  }
}

main();
