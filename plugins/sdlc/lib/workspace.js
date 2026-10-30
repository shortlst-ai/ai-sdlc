'use strict';

// Everything that touches the disk: finding the repo, reading config, and
// reading and writing work items.

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ARTIFACTS, DONE, FLOWS, isValidItem } = require('./machine');

const SDLC_DIR = '.sdlc';
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

const DEFAULT_CONFIG = {
  version: 1,
  commands: { setup: null, verify: null, format: null },
  tracks: { critical: { paths: [] }, quick: { max_files: 3 } },
  protected: [],
  tests: ['test/**', 'tests/**', '**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/test_*.*'],
  limits: { rework: 3 },
};

const AGENT_TEAMS_FLAG = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS';
const WORKTREES_IGNORE = '.claude/worktrees/';

const UNREACHABLE_WARNING =
  'This worktree has no .sdlc/, so the factory gates are off here. The main checkout ' +
  'uses the factory: commit .sdlc/ to the base branch, then start a new worktree.';

// A failure the user can act on, as opposed to a bug. `code` is the exit code.
class SdlcError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new SdlcError(`can't read ${label}: ${error.message}`);
  }
}

// Writes through a rename, so an interrupted run can't leave a half-written file.
function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function sha256(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Walks up from the working directory, so the CLI works from any subfolder. It
// stops at the git boundary because a native worktree sits inside the main repo,
// and walking past it would silently use the main checkout's .sdlc/.
function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, SDLC_DIR))) return dir;
    if (fs.existsSync(path.join(dir, '.git'))) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function gitTop(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// In a linked worktree `.git` is a file pointing at <main>/.git/worktrees/<name>.
// Returns the main checkout when it uses the factory and this worktree can't see
// it, which happens when .sdlc/ was never committed to the base branch.
function unreachableFactory(start) {
  const top = gitTop(start);
  if (!top || findRoot(start)) return null;
  const marker = path.join(top, '.git');
  if (!fs.statSync(marker).isFile()) return null;
  const match = /^gitdir: (.+)\.git\/worktrees\//m.exec(fs.readFileSync(marker, 'utf8'));
  if (!match) return null;
  const main = match[1].replace(/\/$/, '');
  return fs.existsSync(path.join(main, SDLC_DIR)) ? main : null;
}

function workDir(root) {
  return path.join(root, SDLC_DIR, 'work');
}

function assertConfig(config) {
  const valid =
    config?.version === 1 &&
    Array.isArray(config.tracks?.critical?.paths) &&
    Number.isInteger(config.tracks?.quick?.max_files) &&
    Array.isArray(config.protected) &&
    Array.isArray(config.tests) &&
    Number.isInteger(config.limits?.rework);
  if (!valid) throw new SdlcError(`${SDLC_DIR}/config.json doesn't match the expected shape`);
}

function loadConfig(root) {
  const file = path.join(root, SDLC_DIR, 'config.json');
  if (!fs.existsSync(file)) return DEFAULT_CONFIG;
  const config = readJson(file, `${SDLC_DIR}/config.json`);
  assertConfig(config);
  return config;
}

function git(root, args) {
  try {
    const options = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    return execFileSync('git', args, options).trim();
  } catch {
    return null;
  }
}

// Null outside a repo or before the first commit, where work can't be tied to a branch.
function currentBranch(root) {
  return git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

function ignoreWorktrees(root) {
  const file = path.join(root, '.gitignore');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (existing.split('\n').includes(WORKTREES_IGNORE)) return;
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(file, `${existing}${separator}${WORKTREES_IGNORE}\n`);
}

// A plugin can't ship settings, so the project has to turn agent teams on itself.
function enableAgentTeams(root) {
  const dir = path.join(root, '.claude');
  const file = path.join(dir, 'settings.json');
  const settings = fs.existsSync(file) ? readJson(file, '.claude/settings.json') : {};
  if (settings.env?.[AGENT_TEAMS_FLAG] === '1') return;
  fs.mkdirSync(dir, { recursive: true });
  writeJson(file, { ...settings, env: { ...settings.env, [AGENT_TEAMS_FLAG]: '1' } });
}

function init(cwd) {
  const existing = findRoot(cwd);
  if (existing) throw new SdlcError(`factory already initialized at ${existing}`);
  const root = gitTop(cwd) ?? path.resolve(cwd);
  enableAgentTeams(root);
  ignoreWorktrees(root);
  fs.mkdirSync(workDir(root), { recursive: true });
  writeJson(path.join(root, SDLC_DIR, 'config.json'), DEFAULT_CONFIG);
  return root;
}

// Kept in the worktree's own git directory, so it never gets committed and each
// worktree tracks its own setup. Recording the command reruns setup if it changes.
function setupMarker(root) {
  const file = git(root, ['rev-parse', '--git-path', 'sdlc-setup']);
  return file === null ? null : path.resolve(root, file);
}

function isLinkedWorktree(root) {
  const marker = path.join(root, '.git');
  return fs.existsSync(marker) && fs.statSync(marker).isFile();
}

function setupPending(root) {
  const command = loadConfig(root).commands?.setup;
  if (!command || !isLinkedWorktree(root)) return false;
  const marker = setupMarker(root);
  return marker !== null && (!fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== command);
}

function markSetupDone(root, command) {
  const marker = setupMarker(root);
  if (marker !== null) fs.writeFileSync(marker, command);
}

function loadItem(root, id) {
  const dir = path.join(workDir(root), id);
  const item = readJson(path.join(dir, 'state.json'), `state for ${id}`);
  if (!isValidItem(item)) throw new SdlcError(`state for ${id} is invalid`);
  return { ...item, id };
}

function saveItem(root, item) {
  const { id, ...state } = item;
  writeJson(path.join(workDir(root), id, 'state.json'), state);
}

function listIds(root) {
  const dir = workDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function resolveId(root, query) {
  const ids = listIds(root);
  if (ids.includes(query)) return query;
  const matches = /^\d+$/.test(query)
    ? ids.filter((id) => Number(id.split('-')[0]) === Number(query))
    : [];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new SdlcError(`'${query}' is ambiguous: ${matches.join(', ')}`);
  }
  throw new SdlcError(`no work item '${query}'`);
}

// A work item belongs to the branch it was created on, so each worktree session
// sees only its own work. An item with no branch was made outside git.
function ownItems(root) {
  const branch = currentBranch(root);
  return listIds(root)
    .map((id) => loadItem(root, id))
    .filter((item) => !item.branch || item.branch === branch);
}

// With no id given, the single open item is the active one. Choosing between
// several is left to the caller rather than guessed at here.
function activeItem(root, query) {
  if (query) return loadItem(root, resolveId(root, query));
  const open = ownItems(root).filter((item) => item.stage !== DONE);
  if (open.length === 1) return open[0];
  if (open.length === 0) throw new SdlcError('no open work items on this branch');
  throw new SdlcError(`several open work items, so name one: ${open.map((i) => i.id).join(', ')}`);
}

function createItem(root, slug, track, stage) {
  if (!SLUG.test(slug)) {
    throw new SdlcError(`invalid slug '${slug}': use lowercase letters, digits, and hyphens`, 2);
  }
  const highest = Math.max(0, ...listIds(root).map((id) => Number(id.split('-')[0]) || 0));
  const id = `${String(highest + 1).padStart(4, '0')}-${slug}`;
  fs.mkdirSync(workDir(root), { recursive: true });
  try {
    fs.mkdirSync(path.join(workDir(root), id));
  } catch (error) {
    if (error.code === 'EEXIST') throw new SdlcError(`work item ${id} already exists`);
    throw error;
  }
  const item = { id, track, stage, branch: currentBranch(root), rework: 0, history: [] };
  saveItem(root, item);
  return item;
}

// Evidence describes code that's about to change, so a rework cycle can't reuse
// it. Moving it rather than deleting it keeps the failed round in the audit trail.
function archiveEvidence(root, id, cycle) {
  const dir = path.join(workDir(root), id);
  const archive = path.join(dir, 'evidence', `rework-${cycle}`);
  for (const file of [ARTIFACTS.verify, ARTIFACTS.review, 'approvals/merge.json']) {
    const source = path.join(dir, file);
    if (!fs.existsSync(source)) continue;
    fs.mkdirSync(archive, { recursive: true });
    fs.renameSync(source, path.join(archive, path.basename(file)));
  }
}

function saveApproval(root, item, record) {
  const dir = path.join(workDir(root), item.id, 'approvals');
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, `${record.stage}.json`), record);
  const { stage, sha256, approver, at } = record;
  const event = { at, approved: stage, sha256, approver };
  saveItem(root, { ...item, history: [...item.history, event] });
}

// The team config is where Claude Code records each teammate's agent type. It
// exists only while a team is running, so a missing file means no team.
function readTeam(sessionId) {
  if (!/^[\w-]+$/.test(sessionId ?? '')) return null;
  const home = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  const file = path.join(home, 'teams', `session-${sessionId.slice(0, 8)}`, 'config.json');
  return fs.existsSync(file) ? readJson(file, 'the team config') : null;
}

// Gathers what `nextAction` needs to know about one item from the disk.
function readFacts(root, item) {
  const dir = path.join(workDir(root), item.id);
  const artifacts = {};
  const approvals = {};
  for (const { stage } of FLOWS[item.track]) {
    const artifact = ARTIFACTS[stage];
    if (artifact) artifacts[artifact] = sha256(path.join(dir, artifact));
    approvals[stage] = readApproval(path.join(dir, 'approvals', `${stage}.json`));
  }
  return { artifacts, approvals };
}

// An unreadable approval counts as no approval, so the gate stays shut.
function readApproval(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

module.exports = {
  SdlcError,
  UNREACHABLE_WARNING,
  activeItem,
  archiveEvidence,
  createItem,
  findRoot,
  init,
  listIds,
  markSetupDone,
  ownItems,
  loadConfig,
  loadItem,
  readFacts,
  readTeam,
  resolveId,
  saveApproval,
  saveItem,
  setupPending,
  unreachableFactory,
};
