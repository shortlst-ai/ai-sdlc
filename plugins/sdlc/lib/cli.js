'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');

const { changeSize, reviewBuild, reviewSlices } = require('./check');
const { runGates } = require('./gates');
const machine = require('./machine');
const { coverage, detect, intentFor, slugFor } = require('./detect');
const { collect } = require('./metrics');
const workspace = require('./workspace');

const { TRACKS, isOpen } = machine;

// `quick` only survives on finished items from before there was one path.
const CHOOSABLE = TRACKS.filter((track) => track !== 'quick');
const { SdlcError } = workspace;

const USAGE = `Usage: sdlc <command>

Commands:
  init [--setup C] [--verify C] [--format C] [--critical a,b] [--protected a,b]
                                     Set up the factory in this repo
  setup                              Build this worktree's environment
  new <slug> [--files a,b] [--track critical]
                                     Start a work item. Critical paths add sign-offs
  status [<id>] [--json]             Show work items and the next action
  changed [<id>]                     List the files this item has changed
  check [<id>]                       Compare the real diff to the spec's scope
  verify [<id>]                      Run the verify command and record evidence
  advance [<id>]                     Move to the next stage if its gate passes
  rework [<id>] --reason <text>      Send verify or review back to build
  track [<id>] [<track>] [--files a,b]
                                     Raise a track, or add files to the item.
                                     Tracks can never be lowered
  gates --base <ref> [--json]        Recheck every gate, for CI
  metrics [--since <date>] [--json]  Summarize delivery from Git history
  detect --runs <file> --branch <b> [--json]
                                     Compare CI runs to the limits in config
  breach --runs <file> --branch <b> [--json]
                                     Open a work item for each limit broken
  --version                          Print the plugin version
  --help                             Print this help

Exit codes: 0 success, 1 refused, 2 usage error.`;

const OPTIONS = {
  json: { type: 'boolean' },
  files: { type: 'string' },
  track: { type: 'string' },
  reason: { type: 'string' },
  since: { type: 'string' },
  base: { type: 'string' },
  runs: { type: 'string' },
  branch: { type: 'string' },
  setup: { type: 'string' },
  verify: { type: 'string' },
  format: { type: 'string' },
  critical: { type: 'string' },
  protected: { type: 'string' },
};

function requireRoot() {
  const root = workspace.findRoot(process.cwd());
  if (!root) throw new SdlcError('this repo does not use the factory: run sdlc init');
  return root;
}

function parseFiles(value) {
  return value ? value.split(',').map((file) => file.trim()).filter(Boolean) : [];
}

function parseTrack(track) {
  if (!CHOOSABLE.includes(track)) {
    throw new SdlcError(`unknown track '${track}': use ${CHOOSABLE.join(', ')}`, 2);
  }
  return track;
}

function describe(root, item) {
  const next = machine.nextAction(item, workspace.readFacts(root, item));
  return { id: item.id, track: item.track, stage: item.stage, rework: item.rework, next };
}

function record(item, event) {
  return { ...item, history: [...item.history, { at: new Date().toISOString(), ...event }] };
}

function repoNext(items) {
  const open = items.filter(isOpen);
  if (open.length === 0) return { action: 'new' };
  if (open.length === 1) return { id: open[0].id, ...open[0].next };
  return { action: 'choose', ids: open.map((item) => item.id) };
}

function status(positionals, values) {
  const root = workspace.findRoot(process.cwd());
  if (!root) {
    const main = workspace.unreachableFactory(process.cwd());
    if (values.json) {
      console.log(JSON.stringify({ initialized: false, root: null, ...(main && { main_checkout: main }) }));
    } else if (main) {
      console.log(workspace.UNREACHABLE_WARNING);
    } else {
      console.log('This repo does not use the factory: no .sdlc/ directory found.');
    }
    return 0;
  }
  const loaded = positionals[0]
    ? [workspace.loadItem(root, workspace.resolveId(root, positionals[0]))]
    : workspace.ownItems(root);
  const items = loaded.map((item) => describe(root, item));
  const next = repoNext(items);
  if (values.json) {
    console.log(JSON.stringify({ initialized: true, root, items, next }));
    return 0;
  }
  console.log(`Factory root: ${root}`);
  const elsewhere = positionals[0] ? [] : workspace.openElsewhere(root);
  if (items.length === 0 && elsewhere.length === 0) {
    console.log(workspace.listIds(root).length === 0 ? 'No work items yet.' : 'No open work items.');
  }
  for (const item of items) {
    console.log(`${item.id}  ${item.track}  ${item.stage}  next: ${machine.describeNext(item.next)}`);
  }
  for (const { root: dir, item } of elsewhere) {
    const next = machine.nextAction(item, workspace.readFacts(dir, item));
    const where = path.relative(root, dir);
    console.log(`${item.id}  ${item.track}  ${item.stage}  next: ${machine.describeNext(next)}  (in ${where})`);
  }
  return 0;
}

function createNew(positionals, values) {
  const root = requireRoot();
  const [slug] = positionals;
  if (!slug) throw new SdlcError('sdlc new needs a slug', 2);
  const config = workspace.loadConfig(root);
  const files = parseFiles(values.files);
  const classified = machine.classify(files, config);
  const track = values.track ? parseTrack(values.track) : classified;
  if (machine.trackRank(track) < machine.trackRank(classified)) {
    throw new SdlcError(`these files need at least the '${classified}' track, not '${track}'`);
  }
  const item = workspace.createItem(root, slug, track, machine.firstStage(track), files);
  console.log(`${item.id}  ${item.track}  ${item.stage}`);
  return 0;
}

function changed(positionals) {
  const root = requireRoot();
  const item = workspace.activeItem(root, positionals[0]);
  for (const file of workspace.changedFiles(root, item.base)) console.log(file);
  return 0;
}

function check(positionals) {
  const root = requireRoot();
  const item = workspace.activeItem(root, positionals[0]);
  const { problems } = reviewBuild(root, item, workspace.loadConfig(root));
  if (problems.length > 0) throw new SdlcError(`${item.id}: ${problems.join('; ')}`);
  console.log(`${item.id}: the changes match the spec.`);
  const limit = workspace.loadConfig(root).limits.pr_warn_lines ?? 600;
  const size = changeSize(root, item);
  if (limit > 0 && size > limit) {
    console.log(`Warning: ${size} changed lines, over the ${limit} a reviewer can read well. Consider splitting it.`);
  }
  return 0;
}

function tail(text, lines) {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}

// The tool writes the evidence, not an agent, so it's the test output itself. A
// failing run removes any earlier pass, so an old result can't stand in for it.
function verify(positionals) {
  const root = requireRoot();
  const item = workspace.activeItem(root, positionals[0]);
  if (item.stage !== 'verify') throw new SdlcError(`${item.id} is at ${item.stage}, not verify`);
  const command = workspace.loadConfig(root).commands?.verify;
  if (!command) throw new SdlcError('set commands.verify in .sdlc/config.json');
  const result = spawnSync('sh', ['-c', command], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  const output = tail(`${result.stdout ?? ''}${result.stderr ?? ''}`, 200);
  const code = workspace.codeFingerprint(root, item.base);
  const body = `command: ${command}\ncommit: ${workspace.headCommit(root)}\ncode: ${code}\n\n${output}\n`;
  if (result.status !== 0) {
    workspace.removeEvidence(root, item, 'verify.md');
    workspace.writeEvidence(root, item, 'verify-failed.md', body);
    throw new SdlcError(`verify failed: ${command}\n${tail(output, 20)}`);
  }
  workspace.removeEvidence(root, item, 'verify-failed.md');
  workspace.writeEvidence(root, item, 'verify.md', body);
  console.log(`${item.id}: verify passed.`);
  return 0;
}

function advance(positionals) {
  const root = requireRoot();
  let item = workspace.activeItem(root, positionals[0]);
  if (item.stage === 'build') {
    const review = reviewBuild(root, item, workspace.loadConfig(root));
    const problems = [...review.problems, ...reviewSlices(root, review.item)];
    if (problems.length > 0) {
      throw new SdlcError(`can't advance ${item.id}: ${problems.join('; ')}`);
    }
    if (review.item.track !== item.track) {
      const event = { track: { from: item.track, to: review.item.track }, from: item.stage, to: review.item.stage };
      workspace.saveItem(root, record(review.item, event));
      console.log(`${item.id}: its files need the ${review.item.track} track, so the track was raised.`);
      item = workspace.loadItem(root, item.id);
    }
  }
  const result = machine.advance(item, workspace.readFacts(root, item));
  if (!result.ok) {
    if (!isOpen(item)) throw new SdlcError(`${item.id} is already ${item.stage}`);
    throw new SdlcError(`can't advance ${item.id}: ${machine.describeNext(result.next)}`);
  }
  const event = { from: item.stage, to: result.item.stage, commit: workspace.headCommit(root) };
  workspace.saveItem(root, record(result.item, event));
  console.log(`${item.id}  ${item.stage} -> ${result.item.stage}`);
  return 0;
}

function rework(positionals, values) {
  if (!values.reason) throw new SdlcError('sdlc rework needs --reason', 2);
  const root = requireRoot();
  const item = workspace.activeItem(root, positionals[0]);
  const result = machine.rework(item, workspace.loadConfig(root).limits.rework);
  if (!result.ok) throw new SdlcError(`can't rework ${item.id}: ${result.reason}`);
  workspace.archiveEvidence(root, item.id, result.item.rework);
  const event ={ from: item.stage, to: result.item.stage, reason: values.reason };
  workspace.saveItem(root, record(result.item, event));
  console.log(`${item.id}  ${item.stage} -> ${result.item.stage}  (rework ${result.item.rework})`);
  return 0;
}

function track(positionals, values) {
  const root = requireRoot();
  // One positional may be either the id or the track, so check it isn't a track first.
  const named = positionals.find((value) => TRACKS.includes(value));
  const query = positionals.find((value) => !TRACKS.includes(value));
  if (!named && !values.files) throw new SdlcError('sdlc track needs a track or --files', 2);
  const item = workspace.activeItem(root, query);
  const config = workspace.loadConfig(root);
  const candidates = [named, values.files && machine.classify(parseFiles(values.files), config)];
  const wanted = candidates.filter(Boolean);
  if (named && machine.trackRank(named) < machine.trackRank(item.track)) {
    throw new SdlcError(`can't lower the track from '${item.track}' to '${named}'`);
  }
  const target = wanted.reduce(
    (highest, value) => (machine.trackRank(value) > machine.trackRank(highest) ? value : highest),
    item.track,
  );
  const result = machine.raiseTrack(item, target);
  if (!result.ok) throw new SdlcError(`can't change the track: ${result.reason}`);
  if (target !== item.track) {
    const event = { track: { from: item.track, to: target }, from: item.stage, to: result.item.stage };
    workspace.saveItem(root, record(result.item, event));
  }
  console.log(`${item.id}  ${target}  ${result.item.stage}`);
  return 0;
}

function setup() {
  const root = requireRoot();
  const command = workspace.loadConfig(root).commands?.setup;
  if (!command) {
    console.log('No setup command in .sdlc/config.json, so nothing to do.');
    return 0;
  }
  const result = spawnSync('sh', ['-c', command], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new SdlcError(`setup failed: ${command}`);
  workspace.markSetupDone(root, command);
  console.log('Setup finished.');
  return 0;
}

// Exit 1 here is what fails the required check.
function gates(positionals, values) {
  if (!values.base) throw new SdlcError('sdlc gates needs --base', 2);
  const result = runGates(process.cwd(), values.base);
  if (values.json) console.log(JSON.stringify(result));
  else if (!result.factory) console.log('This repo does not use the factory.');
  else if (result.problems.length === 0) {
    const count = result.items.length;
    console.log(`Gates passed for ${count} work ${count === 1 ? 'item' : 'items'}.`);
  }
  else for (const problem of result.problems) console.error(`sdlc: ${problem}`);
  return result.problems.length === 0 ? 0 : 1;
}

function metrics(positionals, values) {
  const summary = collect(process.cwd(), values.since);
  if (values.json) {
    console.log(JSON.stringify(summary));
    return 0;
  }
  const { period, commits, size, signals, approvals } = summary;
  console.log(`${commits.total} commits over ${period.span_days} days, ${period.active_days} active`);
  console.log(`Median change: ${size.median_files} files, ${size.median_lines} lines`);
  console.log(`Fix commits: ${signals.fix_commits}. Reverts: ${signals.reverts}.`);
  console.log(`Commits touching tests: ${signals.touching_tests}`);
  console.log(`Approvals: ${approvals.total} across ${approvals.items} finished items, ${approvals.per_item} each`);
  return 0;
}

// The runs come from `gh run list --json`, which the workflow fetches.
function breaches(values) {
  if (!values.runs || !values.branch) throw new SdlcError('this needs --runs and --branch', 2);
  let runs;
  try {
    runs = JSON.parse(fs.readFileSync(values.runs, 'utf8'));
  } catch (error) {
    throw new SdlcError(`can't read ${values.runs}: ${error.message}`);
  }
  if (!Array.isArray(runs)) throw new SdlcError(`${values.runs} isn't a list of runs`);
  const bands = workspace.bandsOf(workspace.loadConfig(workspace.findRoot(process.cwd()) ?? process.cwd()));
  return { found: detect(runs, values.branch, bands), checked: coverage(runs, values.branch, bands) };
}

function detectCommand(positionals, values) {
  const { found, checked } = breaches(values);
  if (values.json) {
    console.log(JSON.stringify({ breaches: found, checked }));
    return 0;
  }
  if (checked.length === 0) {
    console.log(`Nothing to judge: no workflow has enough finished runs on ${values.branch}.`);
  } else if (found.length === 0) {
    console.log(`Within limits: ${checked.join(', ')}`);
  }
  for (const breach of found) {
    console.log(`${breach.workflow}: ${breach.failed} of ${breach.runs} runs failed, over the limit of ${breach.max}`);
  }
  return 0;
}

// Every item starts at the intent gate, so a person decides whether this is worth
// fixing before anything is built.
function breachCommand(positionals, values) {
  const root = requireRoot();
  const open = workspace.openEverywhere(root).map(({ item }) => item.id.replace(/^\d+-/, ''));
  const created = [];
  for (const breach of breaches(values).found) {
    const slug = slugFor(breach);
    if (!open.includes(slug)) {
      const item = workspace.createItem(root, slug, 'standard', machine.firstStage('standard'));
      workspace.writeArtifact(root, item, 'intent.md', intentFor(breach));
      created.push(item.id);
    }
  }
  if (values.json) console.log(JSON.stringify({ created }));
  else console.log(created.length === 0 ? 'No new breaches.' : `Opened ${created.join(', ')}`);
  return 0;
}

function version() {
  const manifest = path.join(__dirname, '..', '.claude-plugin', 'plugin.json');
  return JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
}

function initialize(positionals, values) {
  const options = {
    commands: { setup: values.setup, verify: values.verify, format: values.format },
    critical: parseFiles(values.critical),
    protected: parseFiles(values.protected),
  };
  console.log(`Factory initialized at ${workspace.init(process.cwd(), options)}`);
  return 0;
}

function dispatch(argv) {
  const [command, ...rest] = argv;
  if (command === '--version') {
    console.log(version());
    return 0;
  }
  if (command === '--help' || command === undefined) {
    console.log(USAGE);
    return 0;
  }
  const commands = {
    init: initialize,
    setup,
    new: createNew,
    status,
    changed,
    check,
    verify,
    advance,
    rework,
    track,
    gates,
    metrics,
    detect: detectCommand,
    breach: breachCommand,
  };
  if (!Object.hasOwn(commands, command)) {
    throw new SdlcError(`unknown command '${command}'\n\n${USAGE}`, 2);
  }
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    throw new SdlcError(error.message, 2);
  }
  return commands[command](parsed.positionals, parsed.values);
}

function run(argv) {
  try {
    return dispatch(argv);
  } catch (error) {
    if (!(error instanceof SdlcError)) throw error;
    console.error(`sdlc: ${error.message}`);
    return error.code;
  }
}

module.exports = { run };
