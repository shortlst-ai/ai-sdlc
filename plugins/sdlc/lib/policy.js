'use strict';

// What an agent may do, as pure decisions. These give fast feedback to an agent
// that's trying to follow the process. They aren't the security boundary: Bash
// can always reach around them, so anything that must hold is rechecked in CI.

const { DONE, matchesAny } = require('./machine');

const ALLOW = { allow: true };

function deny(reason) {
  return { allow: false, reason };
}

// Only the CLI and the approval hook write these. People edit the config by hand.
const MANAGED = ['.sdlc/config.json', '.sdlc/work/*/state.json', '.sdlc/work/*/approvals/**'];

const SDLC_ONLY = 'sdlc-only';
const TESTS_ONLY = 'tests-only';
const READ_ONLY = 'read-only';

const ROLE_SCOPES = {
  'spec-writer': SDLC_ONLY,
  planner: SDLC_ONLY,
  verifier: TESTS_ONLY,
  researcher: READ_ONLY,
  reviewer: READ_ONLY,
  diagnoser: READ_ONLY,
  unassigned: READ_ONLY,
};

// A teammate's hooks report its name as `agent_type`, and the role is only in the
// team config, so that's checked first. That order also stops a teammate from
// claiming a role through its name. In a team, anything without an sdlc role
// can't write, because falling back to the lead's rights would fail open.
function roleOf(agentType, team) {
  const member = team?.members?.find(({ name }) => name === agentType);
  const type = member ? member.agentType : agentType;
  if (type?.startsWith('sdlc:')) return type.slice('sdlc:'.length);
  return team && agentType ? 'unassigned' : null;
}

// A gate from an earlier stage that reopened stops all work until it's resolved.
function isBlockedEarlier({ item, next }) {
  return next.stage !== undefined && next.stage !== item.stage;
}

// Source changes only during build, so code can't change after verify without
// going through rework. On the quick track the test comes first, then it locks,
// so a fix can't weaken the check it has to pass.
function stageAllows(entry, isTest, role) {
  const { item } = entry;
  if (isBlockedEarlier(entry)) return false;
  if (!isTest) return item.stage === 'build' && entry.next.action === 'advance';
  if (item.stage === 'verify' && role === 'verifier') return true;
  return item.track === 'quick' ? item.stage === 'reproduce' : ['build', 'verify'].includes(item.stage);
}

function describeBlock(open) {
  const states = open.map(({ item, describeNext }) => `${item.id} is at ${item.stage}, next: ${describeNext}`);
  return states.join('; ');
}

// `file` is relative to the repo root. `items` lists the open work items, each
// with its `next` action and a readable `describeNext`.
function checkEdit({ file, role, items, config }) {
  if (matchesAny(file, MANAGED)) {
    return deny(`${file} is managed by the sdlc CLI, so it can't be edited directly`);
  }
  if (matchesAny(file, config.protected)) {
    return deny(`${file} is protected by .sdlc/config.json`);
  }
  const scope = ROLE_SCOPES[role];
  if (scope === READ_ONLY) return deny(`the ${role} role can't change files`);
  if (file === '.sdlc' || file.startsWith('.sdlc/')) return ALLOW;
  if (scope === SDLC_ONLY) return deny(`the ${role} role can only write under .sdlc/`);

  const isTest = matchesAny(file, config.tests);
  if (scope === TESTS_ONLY && !isTest) return deny(`the ${role} role can only write test files`);

  const open = items.filter(({ item }) => item.stage !== DONE);
  if (open.length === 0 || open.some((entry) => stageAllows(entry, isTest, role))) return ALLOW;
  return deny(`${file} can't be changed yet: ${describeBlock(open)}`);
}

const SEPARATORS = new Set([';', '|', '&', '\n', '(', ')', '`']);
const HEREDOC = /^<<-?\s*(['"]?)([\w.-]+)\1/;

// Returns the index of the end of the bodies that start after `newline`. A body
// with no closing line runs to the end of the command, as it does in a shell.
function skipHeredocs(command, newline, delimiters) {
  let position = newline;
  for (const delimiter of delimiters) {
    for (;;) {
      if (position >= command.length) return command.length;
      const end = command.indexOf('\n', position + 1);
      const stop = end === -1 ? command.length : end;
      const line = command.slice(position + 1, stop);
      position = stop;
      if (line.replace(/^\t+/, '') === delimiter) break;
    }
  }
  return position;
}

// Splits a command line into one token list per simple command. It's a sketch of
// shell parsing, enough to tell a real `git push` from one inside a commit message.
function splitCommands(command) {
  const commands = [];
  let tokens = [];
  let token = null;
  let quote = null;
  let heredocs = [];
  const endToken = () => {
    if (token !== null) tokens.push(token);
    token = null;
  };
  const endCommand = () => {
    endToken();
    if (tokens.length > 0) commands.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"') token += command[(i += 1)] ?? '';
      else token += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      token ??= '';
    } else if (char === '\\') {
      token = (token ?? '') + (command[(i += 1)] ?? '');
    } else if (command.startsWith('<<', i)) {
      const match = HEREDOC.exec(command.slice(i));
      if (match) {
        endToken();
        heredocs.push(match[2]);
        i += match[0].length - 1;
      } else {
        i += 1;
      }
    } else if (char === '\n' && heredocs.length > 0) {
      endCommand();
      i = skipHeredocs(command, i, heredocs);
      heredocs = [];
    } else if (SEPARATORS.has(char)) {
      endCommand();
    } else if (char === '>') {
      endToken();
      tokens.push('>');
      if (command[i + 1] === '>') i += 1;
    } else if (/\s/.test(char)) {
      endToken();
    } else {
      token = (token ?? '') + char;
    }
  }
  endCommand();
  return commands;
}

const WRAPPERS = new Set(['sudo', 'command', 'env', 'time', 'nohup', 'exec']);
const SHELLS = new Set(['sh', 'bash', 'zsh']);

function unwrap(tokens) {
  let i = 0;
  while (i < tokens.length && (WRAPPERS.has(tokens[i]) || /^\w+=/.test(tokens[i]))) i += 1;
  return tokens.slice(i);
}

// Looks inside `bash -c "..."` and `eval "..."`, so wrapping a command can't hide it.
function expand(command) {
  const commands = [];
  for (const raw of splitCommands(command)) {
    const tokens = unwrap(raw);
    const flag = tokens.indexOf('-c');
    if (SHELLS.has(tokens[0]) && flag !== -1 && tokens[flag + 1]) {
      commands.push(...expand(tokens[flag + 1]));
    } else if (tokens[0] === 'eval') {
      commands.push(...expand(tokens.slice(1).join(' ')));
    } else if (tokens.length > 0) {
      commands.push(tokens);
    }
  }
  return commands;
}

const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

function gitArgs(tokens) {
  let i = 1;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    i += GIT_VALUE_OPTIONS.has(tokens[i]) ? 2 : 1;
  }
  return tokens.slice(i);
}

const DEFAULT_BRANCHES = new Set(['main', 'master']);

function refTarget(refspec) {
  const destination = refspec.replace(/^\+/, '').split(':').pop();
  return destination.replace(/^refs\/heads\//, '');
}

function pushesDefaultBranch(args, facts) {
  if (args.includes('--all') || args.includes('--mirror')) return true;
  const positional = args.slice(1).filter((arg) => !arg.startsWith('-'));
  const refs = positional.slice(1);
  const targets = refs.length > 0 ? refs.map(refTarget) : [facts.currentBranch()];
  return targets.some((target) => DEFAULT_BRANCHES.has(target));
}

const SECRET_FILES = ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/id_rsa', '**/secrets.*', '**/credentials*'];
const NOT_SECRET = /\.(example|sample|template)$/;

function secretsIn(files) {
  return files.filter((file) => matchesAny(file, SECRET_FILES) && !NOT_SECRET.test(file));
}

function stagesEverything(args) {
  return args.slice(1).some((arg) => ['.', '-A', '--all', '-u', '--update', ':/'].includes(arg));
}

function checkGit(tokens, facts) {
  const args = gitArgs(tokens);
  const [subcommand] = args;
  const skipsHooks =
    args.includes('--no-verify') || (subcommand === 'commit' && args.some((arg) => /^-[a-zA-Z]*n/.test(arg)));
  if (['commit', 'push', 'merge', 'rebase'].includes(subcommand) && skipsHooks) {
    return deny('skipping git hooks is not allowed');
  }
  if (subcommand === 'push' && pushesDefaultBranch(args, facts)) {
    return deny('agents can\'t push to the default branch, so open a pull request');
  }
  if (subcommand === 'add') {
    const named = args.slice(1).filter((arg) => !arg.startsWith('-'));
    const files = stagesEverything(args) ? [...named, ...facts.changedFiles()] : named;
    const secrets = secretsIn(files);
    if (secrets.length > 0) return deny(`this would stage secrets: ${secrets.join(', ')}`);
  }
  if (subcommand === 'commit') {
    const secrets = secretsIn(facts.stagedFiles());
    if (secrets.length > 0) return deny(`this would commit secrets: ${secrets.join(', ')}`);
  }
  return ALLOW;
}

function checkGh(tokens) {
  if (tokens[1] === 'pr' && tokens[2] === 'merge') {
    return deny('agents can\'t merge pull requests, so ask a person to');
  }
  if (tokens[1] === 'api' && tokens.some((token) => /pulls\/\d+\/merge/.test(token))) {
    return deny('agents can\'t merge pull requests, so ask a person to');
  }
  return ALLOW;
}

const READ_COMMANDS = new Set(['cat', 'ls', 'head', 'tail', 'grep', 'rg', 'jq', 'wc', 'diff', 'git', 'less', 'stat', 'sdlc']);
const MANAGED_PATH = /(^|\/)\.sdlc\/(config\.json$|work\/[^/]+\/(state\.json$|approvals(\/|$)))/;

function checkManaged(tokens) {
  if (tokens.some((token) => token.endsWith('on-approve.js'))) {
    return deny('approvals have to come from a person typing /sdlc:approve');
  }
  const writes = tokens.some((token, i) => {
    if (!MANAGED_PATH.test(token)) return false;
    return tokens[i - 1] === '>' || !READ_COMMANDS.has(tokens[0]);
  });
  return writes ? deny('files managed by the sdlc CLI can\'t be changed directly') : ALLOW;
}

// `facts` holds functions, so git only runs for commands that need the answer.
function checkCommand(command, facts) {
  for (const tokens of expand(command)) {
    const checks = [checkManaged(tokens)];
    if (tokens[0] === 'git') checks.push(checkGit(tokens, facts));
    if (tokens[0] === 'gh') checks.push(checkGh(tokens));
    const denied = checks.find((check) => !check.allow);
    if (denied) return denied;
  }
  return ALLOW;
}

module.exports = { checkCommand, checkEdit, roleOf, splitCommands };
