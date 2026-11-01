#!/usr/bin/env node
'use strict';

// Stop hook, run in the background with asyncRewake. A session stopped at a gate
// has nothing to wake it, and the person may approve from another session. So this
// waits for the state to move, and exit 2 wakes the session to carry on. It only
// watches: approvals are recorded by the hook on the command a person types.

const fs = require('node:fs');
const { setTimeout: sleep } = require('node:timers/promises');

const machine = require('../lib/machine');
const workspace = require('../lib/workspace');

const POLL_MS = Number(process.env.SDLC_AWAIT_POLL_MS) || 5000;

function atGate(root, item) {
  return machine.nextAction(item, workspace.readFacts(root, item)).action === 'approve';
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function claim(marker) {
  const holder = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : 0;
  if (holder && isAlive(holder)) return false;
  fs.writeFileSync(marker, String(process.pid));
  return true;
}

async function wait(root, id) {
  const parent = process.ppid;
  // A session that ended leaves this process to its own devices, so leave too.
  while (process.ppid === parent) {
    await sleep(POLL_MS);
    const item = workspace.loadItem(root, id);
    if (!machine.isOpen(item)) return 0;
    if (!atGate(root, item)) {
      console.error(`A person approved ${id}, so continue with /sdlc:next.`);
      return 2;
    }
  }
  return 0;
}

async function main() {
  // Nobody can approve in an unattended session, and waiting would keep `claude -p`
  // running until the hook's timeout.
  if (process.env.CLAUDE_CODE_SESSION_ATTENDED === '0') return 0;
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const root = workspace.findRoot(input.cwd);
  if (!root) return 0;
  const waiting = workspace
    .ownItems(root)
    .filter(machine.isOpen)
    .filter((item) => atGate(root, item));
  if (waiting.length !== 1) return 0;
  const { id } = waiting[0];
  const marker = workspace.waitMarker(root, id);
  if (marker === null || !claim(marker)) return 0;
  try {
    return await wait(root, id);
  } finally {
    fs.rmSync(marker, { force: true });
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.exitCode = 0;
  },
);
