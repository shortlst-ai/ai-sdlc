'use strict';

// Everything that touches the disk: finding the repo, reading config, and
// reading and writing work items.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { ARTIFACTS, FLOWS, isValidItem } = require('./machine');

const SDLC_DIR = '.sdlc';
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

const DEFAULT_CONFIG = {
  version: 1,
  commands: { verify: null, format: null },
  tracks: { critical: { paths: [] }, quick: { max_files: 3 } },
  protected: [],
  limits: { rework: 3 },
};

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

// Walks up from the working directory, so the CLI works from any subfolder.
function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, SDLC_DIR))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
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

function init(cwd) {
  const existing = findRoot(cwd);
  if (existing) throw new SdlcError(`factory already initialized at ${existing}`);
  const root = path.resolve(cwd);
  fs.mkdirSync(workDir(root), { recursive: true });
  writeJson(path.join(root, SDLC_DIR, 'config.json'), DEFAULT_CONFIG);
  return root;
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
  const item = { id, track, stage, rework: 0, history: [] };
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
  archiveEvidence,
  createItem,
  findRoot,
  init,
  listIds,
  loadConfig,
  loadItem,
  readFacts,
  resolveId,
  saveItem,
};
