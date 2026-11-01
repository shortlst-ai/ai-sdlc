#!/bin/bash
# Builds a repo with one standard work item at a chosen point, using the real CLI
# so the fixture can't drift from what the factory writes. Sourced by each case.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
sdlc() { node "$PLUGIN_ROOT/bin/sdlc" "$@"; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
ITEM=.sdlc/work/0001-feature

approval() {
  mkdir -p "$ITEM/approvals"
  printf '{"stage":"%s","artifact":"%s","sha256":"%s","approver":{"name":"Ada","email":"ada@example.com"},"at":"2026-10-31T12:00:00Z"}\n' \
    "$1" "$2" "$(sha "$ITEM/$2")" >"$ITEM/approvals/$1.json"
}

commit() {
  git add -A
  git commit -q -m "$1"
}

# Runs are sandboxed away from the plugin's own folder, so the CLI they call lives
# in the workspace. `sdlc` on PATH would be the same code.
install_cli() {
  mkdir -p .tools/plugin
  cp -R "$PLUGIN_ROOT/bin" "$PLUGIN_ROOT/lib" "$PLUGIN_ROOT/.claude-plugin" .tools/plugin/
  # The sandbox can't read Homebrew's OpenSSL config, which node loads at startup.
  printf '#!/bin/sh\nOPENSSL_CONF=/dev/null exec node "$(dirname "$0")/plugin/bin/sdlc" "$@"\n' >.tools/sdlc
  chmod +x .tools/sdlc
  printf '.tools/\n' >>.git/info/exclude
}

base_repo() {
  git init -q -b main
  git config user.name Ada
  git config user.email ada@example.com
  install_cli
  printf 'def add(a, b):\n    return a + b\n' >calc.py
  sdlc init --verify true >/dev/null
  commit 'Adopt the factory'
}

at_spec_gate() {
  base_repo
  git switch -q -c worktree-feature
  sdlc new feature >/dev/null
  printf '# Spec\n\ncalc.py gains subtract(a, b).\n' >"$ITEM/spec.md"
  commit 'Write the spec'
}

# $1 is the review report.
at_merge() {
  at_spec_gate
  approval spec spec.md
  printf '# Plan\n\n```scope\ncalc.py\n```\n' >"$ITEM/plan.md"
  sdlc advance >/dev/null
  sdlc advance >/dev/null
  printf 'def subtract(a, b):\n    return a - b\n' >>calc.py
  commit 'Add subtract'
  sdlc advance >/dev/null
  sdlc verify >/dev/null
  sdlc advance >/dev/null
  printf '%s\n' "$1" >"$ITEM/evidence/review.md"
  sdlc advance >/dev/null
  commit 'Reach the merge stage'
}
