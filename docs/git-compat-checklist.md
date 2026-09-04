# Git Compatibility Checklist (M11)

Automated coverage lives in `src/test/gitCompat.test.ts`. Manual E2E on Windows + VS Code + WSL:

## Must pass

- [ ] `git status` shows agent-edited files as modified (not committed by WSLDeck)
- [ ] VS Code Source Control lists the same dirty files
- [ ] Stage → Commit → Push works normally after Keep
- [ ] WSLDeck never auto-commits or auto-pushes
- [ ] Chinese / spaced paths: Keep + conflict gate
- [ ] User edits Main while agent runs → Keep blocked (conflicted), Main not overwritten
- [ ] `git reset`, `git checkout`, branch switch unaffected by `.WSLDeck/sessions/` metadata

## Session baseline

Agent edits Main directly. At session start WSLDeck records baseline (Git HEAD or `.WSLDeck/sessions/<id>/baseline/` snapshot). Legacy in-repo `.WSLDeck/shadows` and old `~/.local/share/wsldeck-extension/` shadow dirs are no longer used; activation removes `.WSLDeck/shadows` when detected.

## Baseline after Keep

Successful Keep advances a per-file baseline overlay so a repeat Keep on the same content does not false-conflict. New agent edits to the same file reopen the row as pending.
