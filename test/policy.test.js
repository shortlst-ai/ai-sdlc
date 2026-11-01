'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { checkCommand, checkEdit, roleOf, splitCommands } = require('../plugins/sdlc/lib/policy');

const CONFIG = { protected: ['src/gen/**'], tests: ['tests/**', '**/test_*.py'] };

function open(track, stage, next = { action: 'advance', to: 'x' }) {
  return { item: { id: '0001-x', track, stage }, next, describeNext: 'do the next thing' };
}

function edit(file, { role = null, items = [] } = {}) {
  return checkEdit({ file, role, items, config: CONFIG });
}

function run(command, overrides = {}) {
  return checkCommand(command, {
    currentBranch: () => 'feature',
    stagedFiles: () => [],
    changedFiles: () => [],
    ...overrides,
  });
}

const allowed = (decision) => assert.equal(decision.allow, true, decision.reason);
const denied = (decision, pattern) => {
  assert.equal(decision.allow, false);
  assert.match(decision.reason, pattern);
};

describe('roles', () => {
  test('reads the role from a namespaced agent type', () => {
    assert.equal(roleOf('sdlc:builder'), 'builder');
  });

  test('anything else has no role', () => {
    for (const type of [undefined, null, 'Explore', 'workflow-subagent', 'other:builder']) {
      assert.equal(roleOf(type), null);
    }
  });

  const team = {
    members: [
      { name: 'team-lead', agentType: 'team-lead' },
      { name: 'bob', agentType: 'sdlc:builder' },
      { name: 'rita', agentType: 'sdlc:reviewer' },
      { name: 'sam', agentType: 'general-purpose' },
      { name: 'pat' },
      { name: 'sdlc:builder', agentType: 'sdlc:reviewer' },
    ],
  };

  test('a teammate\'s role comes from the team config', () => {
    assert.equal(roleOf('bob', team), 'builder');
    assert.equal(roleOf('rita', team), 'reviewer');
  });

  test('the lead has no agent_type and stays unrestricted', () => {
    assert.equal(roleOf(undefined, team), null);
  });

  test('a subagent spawned inside a team keeps its sdlc role', () => {
    assert.equal(roleOf('sdlc:verifier', team), 'verifier');
  });

  test('a teammate outside our roles gets no write access', () => {
    assert.equal(roleOf('sam', team), 'unassigned');
    assert.equal(roleOf('pat', team), 'unassigned');
    denied(edit('src/a.py', { role: 'unassigned' }), /can't change files/);
  });

  test('an agent that isn\'t a member gets no write access in a team', () => {
    assert.equal(roleOf('ghost', team), 'unassigned');
    assert.equal(roleOf('general-purpose', team), 'unassigned');
  });

  test('a name can\'t claim a role it wasn\'t given', () => {
    assert.equal(roleOf('sdlc:builder', team), 'reviewer');
  });
});

describe('managed and protected files', () => {
  for (const file of [
    '.sdlc/config.json',
    '.sdlc/work/0001-x/state.json',
    '.sdlc/work/0001-x/approvals/spec.json',
  ]) {
    test(`nobody edits ${file}, whatever the role`, () => {
      denied(edit(file), /managed/);
      denied(edit(file, { role: 'builder' }), /managed/);
    });
  }

  test('protected paths are refused even during build', () => {
    denied(edit('src/gen/a.py', { items: [open('standard', 'build')] }), /protected/);
  });

  test('artifacts can be written at any stage', () => {
    allowed(edit('.sdlc/work/0001-x/spec.md', { items: [open('standard', 'spec')] }));
  });
});

describe('role scopes', () => {
  const during = { items: [open('standard', 'build')] };

  test('spec-writer writes under .sdlc/ only', () => {
    const role = 'spec-writer';
    allowed(edit('.sdlc/work/0001-x/spec.md', { role, ...during }));
    denied(edit('src/a.py', { role, ...during }), /only write under .sdlc/);
  });

  test('verifier writes tests but not source', () => {
    allowed(edit('tests/test_a.py', { role: 'verifier', ...during }));
    denied(edit('src/a.py', { role: 'verifier', ...during }), /only write test files/);
  });

  for (const role of ['researcher', 'reviewer', 'diagnoser']) {
    test(`${role} changes nothing`, () => {
      denied(edit('src/a.py', { role, ...during }), /can't change files/);
      denied(edit('.sdlc/work/0001-x/spec.md', { role, ...during }), /can't change files/);
    });
  }
});

describe('stage gate on source files', () => {
  test('no open work means no gate', () => {
    allowed(edit('src/a.py'));
    allowed(edit('src/a.py', { items: [open('standard', 'done')] }));
  });

  test('source can change during build', () => {
    allowed(edit('src/a.py', { items: [open('standard', 'build')] }));
  });

  for (const stage of ['intent', 'spec', 'verify', 'review', 'merge']) {
    test(`source can't change at ${stage}`, () => {
      denied(edit('src/a.py', { items: [open('standard', stage)] }), /can't be changed yet/);
    });
  }

  test('a reopened gate stops build', () => {
    const next = { action: 'approve', stage: 'spec', artifact: 'spec.md', stale: true };
    denied(edit('src/a.py', { items: [open('standard', 'build', next)] }), /can't be changed yet/);
  });

  test('one item in build is enough when several are open', () => {
    allowed(edit('src/a.py', { items: [open('standard', 'spec'), open('standard', 'build')] }));
  });

  test('the refusal says what to do next', () => {
    denied(edit('src/a.py', { items: [open('standard', 'spec')] }), /0001-x is at spec, next: do the next thing/);
  });
});

describe('test files', () => {
  test('standard: tests can change during build and verify', () => {
    allowed(edit('tests/test_a.py', { items: [open('standard', 'build')] }));
    allowed(edit('tests/test_a.py', { items: [open('standard', 'verify')] }));
  });

  test('standard: tests can\'t change before build or after verify', () => {
    denied(edit('tests/test_a.py', { items: [open('standard', 'spec')] }), /can't be changed yet/);
    denied(edit('tests/test_a.py', { items: [open('standard', 'review')] }), /can't be changed yet/);
  });

  test('a reopened gate stops tests too', () => {
    const next = { action: 'approve', stage: 'spec', artifact: 'spec.md', stale: true };
    denied(edit('tests/test_a.py', { items: [open('standard', 'verify', next)] }), /can't be changed yet/);
  });
});

describe('splitting commands', () => {
  test('quotes keep their contents together', () => {
    assert.deepEqual(splitCommands(`git commit -m "fix; it's && done"`), [
      ['git', 'commit', '-m', "fix; it's && done"],
    ]);
  });

  test('operators separate commands', () => {
    const commands = splitCommands('a && b || c; d | e & f');
    assert.deepEqual(commands.map(([first]) => first), ['a', 'b', 'c', 'd', 'e', 'f']);
  });

  test('redirects become their own token', () => {
    assert.deepEqual(splitCommands('echo hi >file >>other'), [['echo', 'hi', '>', 'file', '>', 'other']]);
  });

  test('an empty quoted argument is kept', () => {
    assert.deepEqual(splitCommands(`a "" b`), [['a', '', 'b']]);
  });
});

describe('heredocs', () => {
  const body = (text) => `git commit -F - <<'EOF'\n${text}\nEOF`;

  test('a body is data, not commands', () => {
    allowed(run(body('stop running\ngit push origin main')));
    allowed(run(body('rm .sdlc/config.json')));
  });

  test('an apostrophe in a body can\'t hide what comes next', () => {
    denied(run(`${body("don't stop")}\ngit push origin main`), /default branch/);
  });

  test('commands before and after a body are still checked', () => {
    denied(run(`git push origin main && cat <<EOF\nhi\nEOF`), /default branch/);
    denied(run(`cat <<EOF\nhi\nEOF\ngh pr merge 1`), /merge pull requests/);
  });

  test('each delimiter form works', () => {
    for (const opener of ['<<EOF', '<< EOF', '<<"EOF"', "<<'EOF'", '<<-EOF']) {
      denied(run(`cat ${opener}\ndon't\nEOF\ngit push origin main`), /default branch/);
    }
  });

  test('a tab-indented close ends a <<- body', () => {
    denied(run(`cat <<-EOF\n\tdon't\n\tEOF\ngit push origin main`), /default branch/);
  });

  test('two bodies on one line are both skipped', () => {
    const command = `cat <<A <<B\ngit push origin main\nA\ngh pr merge 1\nB\ngit push origin main`;
    denied(run(command), /default branch/);
    assert.deepEqual(splitCommands(command).map(([first]) => first), ['cat', 'git']);
  });

  test('a body with no close runs to the end', () => {
    allowed(run(`cat <<EOF\ngit push origin main`));
  });

  test('a here-string is not a heredoc', () => {
    denied(run(`cat <<< hi\ngit push origin main`), /default branch/);
  });

  test('<< inside quotes is just text', () => {
    denied(run(`git commit -m "a <<EOF b"\ngit push origin main`), /default branch/);
  });
});

describe('pushing', () => {
  const onMain = { currentBranch: () => 'main' };

  for (const command of [
    'git push origin main',
    'git push origin master',
    'git push origin HEAD:main',
    'git push origin +main',
    'git push origin feature:refs/heads/main',
    'git push -u origin main',
    'git push --force origin main',
    'git -C /repo push origin main',
    'git push --all',
    'git push --mirror',
    'ok && git push origin main',
    'bash -c "git push origin main"',
    `sh -c 'cd x && git push origin main'`,
    'eval "git push origin main"',
    'env FOO=1 git push origin main',
    'FOO=1 git push origin main',
    '(git push origin main)',
    'echo $(git push origin main)',
  ]) {
    test(`refuses: ${command}`, () => {
      denied(run(command), /default branch/);
    });
  }

  test('a bare push is judged by the current branch', () => {
    denied(run('git push', onMain), /default branch/);
    denied(run('git push origin', onMain), /default branch/);
    allowed(run('git push'));
  });

  test('feature branches can push', () => {
    allowed(run('git push origin feature'));
    allowed(run('git push -u origin feature', onMain));
    allowed(run('git push origin main-fix'));
  });

  test('text that only mentions a push is fine', () => {
    allowed(run('git commit -m "stop git push origin main in CI"'));
    allowed(run('echo "git push origin main"'));
    allowed(run('grep "gh pr merge" README.md'));
  });
});

describe('skipping hooks', () => {
  for (const command of [
    'git commit --no-verify -m x',
    'git commit -n -m x',
    'git commit -nm x',
    'git push --no-verify origin feature',
    'git merge --no-verify feature',
  ]) {
    test(`refuses: ${command}`, () => {
      denied(run(command), /skipping git hooks/);
    });
  }

  test('similar flags are fine', () => {
    allowed(run('git commit -m x'));
    allowed(run('git commit -am x'));
    allowed(run('git push -n origin feature'));
  });
});

describe('merging pull requests', () => {
  test('refuses gh pr merge', () => {
    denied(run('gh pr merge 12 --squash'), /merge pull requests/);
  });

  test('refuses the merge API', () => {
    denied(run('gh api -X PUT repos/a/b/pulls/12/merge'), /merge pull requests/);
  });

  test('other gh commands are fine', () => {
    allowed(run('gh pr create --title x'));
    allowed(run('gh pr view 12'));
  });
});

describe('secrets', () => {
  for (const file of ['.env', 'config/.env.local', 'id_rsa', 'a/server.pem', 'tls.key', 'secrets.json', 'credentials.json', 'config/secrets.env']) {
    test(`refuses staging ${file}`, () => {
      denied(run(`git add ${file}`), /stage secrets/);
    });
  }

  for (const file of ['.env.example', 'config/secrets.env.example', 'src/keys.py', 'src/app.py']) {
    test(`allows staging ${file}`, () => {
      allowed(run(`git add ${file}`));
    });
  }

  test('adding everything checks what would be staged', () => {
    const changedFiles = () => ['src/a.py', '.env'];
    for (const command of ['git add .', 'git add -A', 'git add --all', 'git add -u']) {
      denied(run(command, { changedFiles }), /stage secrets: .env/);
    }
    allowed(run('git add .', { changedFiles: () => ['src/a.py'] }));
  });

  test('a named add doesn\'t get blocked by an unrelated changed file', () => {
    allowed(run('git add src/a.py', { changedFiles: () => ['.env'] }));
  });

  test('add and commit in one command is caught at the add', () => {
    denied(run('git add .env && git commit -m x'), /stage secrets/);
  });

  test('a commit is judged by what is staged', () => {
    denied(run('git commit -m x', { stagedFiles: () => ['.env'] }), /commit secrets/);
    allowed(run('git commit -m x', { stagedFiles: () => ['src/a.py'] }));
  });

  test('an unstaged secret doesn\'t block a commit', () => {
    allowed(run('git commit -m x', { changedFiles: () => ['.env'] }));
  });
});

describe('managed files through Bash', () => {
  const state = '.sdlc/work/0001-x/state.json';
  const approval = '.sdlc/work/0001-x/approvals/spec.json';

  for (const command of [
    `echo '{}' > ${approval}`,
    `echo x >> ${state}`,
    `cat other > ${state}`,
    `cp a ${approval}`,
    `mv a ${state}`,
    `rm ${state}`,
    `sed -i '' s/a/b/ ${state}`,
    `tee ${approval}`,
    'echo x > .sdlc/config.json',
    `bash -c "echo x > ${state}"`,
    'rm -rf .sdlc/work/0001-x/approvals',
    'cp a /repo/.sdlc/work/0001-x/approvals/spec.json',
  ]) {
    test(`refuses: ${command}`, () => {
      denied(run(command), /managed by the sdlc CLI/);
    });
  }

  test('running the human command hook directly is refused', () => {
    denied(run('node plugins/sdlc/scripts/on-human-command.js approve'), /person typing/);
  });

  for (const command of [`cat ${state}`, `jq . ${approval}`, `git add ${approval}`, `ls .sdlc/work/0001-x/approvals`]) {
    test(`reading is fine: ${command}`, () => {
      allowed(run(command));
    });
  }

  test('ordinary files are not affected', () => {
    allowed(run('echo x > notes.txt'));
    allowed(run('rm src/a.py'));
  });
});
