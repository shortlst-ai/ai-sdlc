'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');

const machine = require('./machine');
const { collect } = require('./metrics');
const workspace = require('./workspace');

const { DONE, TRACKS } = machine;
const { SdlcError } = workspace;

const USAGE = `Usage: sdlc <command>

Commands:
  init                               Set up the factory in this directory
  new <slug> [--files a,b] [--track T]
                                     Start a work item. Files decide the track
  status [<id>] [--json]             Show work items and the next action
  advance [<id>]                     Move to the next stage if its gate passes
  rework [<id>] --reason <text>      Send verify or review back to build
  track [<id>] [<track>] [--files a,b]
                                     Raise a track. Tracks can never be lowered
  metrics [--since <date>] [--json]  Summarize delivery from Git history
  --version                          Print the plugin version
  --help                             Print this help

Exit codes: 0 success, 1 refused, 2 usage error.`;

const OPTIONS = {
  json: { type: 'boolean' },
  files: { type: 'string' },
  track: { type: 'string' },
  reason: { type: 'string' },
  since: { type: 'string' },
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
  if (!TRACKS.includes(track)) {
    throw new SdlcError(`unknown track '${track}': use ${TRACKS.join(', ')}`, 2);
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
  const open = items.filter((item) => item.stage !== DONE);
  if (open.length === 0) return { action: 'new' };
  if (open.length === 1) return { id: open[0].id, ...open[0].next };
  return { action: 'choose', ids: open.map((item) => item.id) };
}

function status(positionals, values) {
  const root = workspace.findRoot(process.cwd());
  if (!root) {
    if (values.json) console.log(JSON.stringify({ initialized: false, root: null }));
    else console.log('This repo does not use the factory: no .sdlc/ directory found.');
    return 0;
  }
  const ids = positionals[0]
    ? [workspace.resolveId(root, positionals[0])]
    : workspace.listIds(root);
  const items = ids.map((id) => describe(root, workspace.loadItem(root, id)));
  const next = repoNext(items);
  if (values.json) {
    console.log(JSON.stringify({ initialized: true, root, items, next }));
    return 0;
  }
  console.log(`Factory initialized at ${root}`);
  if (items.length === 0) console.log('No work items yet.');
  for (const item of items) {
    console.log(`${item.id}  ${item.track}  ${item.stage}  next: ${machine.describeNext(item.next)}`);
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
  const item = workspace.createItem(root, slug, track, machine.firstStage(track));
  console.log(`${item.id}  ${item.track}  ${item.stage}`);
  return 0;
}

function advance(positionals) {
  const root = requireRoot();
  const item = workspace.activeItem(root, positionals[0]);
  const result = machine.advance(item, workspace.readFacts(root, item));
  if (!result.ok) {
    if (item.stage === DONE) throw new SdlcError(`${item.id} is already done`);
    throw new SdlcError(`can't advance ${item.id}: ${machine.describeNext(result.next)}`);
  }
  workspace.saveItem(root, record(result.item, { from: item.stage, to: result.item.stage }));
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

function metrics(positionals, values) {
  const summary = collect(process.cwd(), values.since);
  if (values.json) {
    console.log(JSON.stringify(summary));
    return 0;
  }
  const { period, commits, size, signals } = summary;
  console.log(`${commits.total} commits over ${period.span_days} days, ${period.active_days} active`);
  console.log(`Median change: ${size.median_files} files, ${size.median_lines} lines`);
  console.log(`Fix commits: ${signals.fix_commits}. Reverts: ${signals.reverts}.`);
  console.log(`Commits touching tests: ${signals.touching_tests}`);
  return 0;
}

function version() {
  const manifest = path.join(__dirname, '..', '.claude-plugin', 'plugin.json');
  return JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
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
    init: () => {
      console.log(`Factory initialized at ${workspace.init(process.cwd())}`);
      return 0;
    },
    new: createNew,
    status,
    advance,
    rework,
    track,
    metrics,
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
