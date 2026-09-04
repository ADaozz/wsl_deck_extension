#!/usr/bin/env bash
# Manual hard-gate demo: agent edits must not dirty Main until Accept.
# Usage: from repo root, ./scripts/demo-shadow-hard-gate.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

MAIN="$TMP/main"
mkdir -p "$MAIN"
echo 'baseline' >"$MAIN/note.txt"
git -C "$MAIN" init -q
git -C "$MAIN" config user.email 'demo@wsldeck.local'
git -C "$MAIN" config user.name 'WSLDeck Demo'
git -C "$MAIN" add note.txt
git -C "$MAIN" commit -q -m init

export HOME="$TMP"
SHADOW_ROOT="$HOME/.local/share/wsldeck-extension/workspaces"
# Simulate ShadowWorkspaceManager via git worktree
REPO_ID="$(printf '%s' "$MAIN" | sha256sum | cut -c1-16)"
SESSION='demo-session'
SHADOW="$SHADOW_ROOT/$REPO_ID/$SESSION"
mkdir -p "$(dirname "$SHADOW")"
git -C "$MAIN" worktree add --detach "$SHADOW" HEAD

echo 'agent write' >"$SHADOW/note.txt"
STATUS_BEFORE="$(git -C "$MAIN" status --porcelain)"
if [[ -n "$STATUS_BEFORE" ]]; then
  echo "FAIL: Main dirty before Accept: $STATUS_BEFORE" >&2
  exit 1
fi
echo "OK: Main clean while shadow dirty"

cp "$SHADOW/note.txt" "$MAIN/note.txt"
STATUS_AFTER="$(git -C "$MAIN" status --porcelain)"
if [[ -z "$STATUS_AFTER" ]]; then
  echo "FAIL: Main still clean after Accept" >&2
  exit 1
fi
echo "OK: Main dirty after Accept: $STATUS_AFTER"

COMMITS="$(git -C "$MAIN" status)"
if echo "$COMMITS" | grep -qi 'ahead'; then
  echo "FAIL: unexpected ahead commits" >&2
  exit 1
fi
# No new commit: HEAD message still "init"
HEAD_MSG="$(git -C "$MAIN" log -1 --pretty=%s)"
[[ "$HEAD_MSG" == "init" ]] || { echo "FAIL: HEAD changed"; exit 1; }
echo "OK: no auto-commit (HEAD still init)"

git -C "$MAIN" worktree remove -f "$SHADOW"
echo "Hard-gate demo passed."
