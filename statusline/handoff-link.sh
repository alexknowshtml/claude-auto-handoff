#!/usr/bin/env bash
# Status line wrapper: runs your status line command, then adds one line with the viewer link
# when this session came from an auto-handoff. Set it as the statusLine command:
#   handoff-link.sh <your status line command> [args...]
# The link comes from the previous brief, whose header names this session in "to:" and the page in "viewer:".
input=$(cat)
# Captured so its trailing newlines drop; the link line then sits right under it.
if [ $# -gt 0 ]; then out=$(printf '%s' "$input" | "$@"); printf '%s' "$out"; fi
sid=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
[ -n "$sid" ] || exit 0
brief=$(grep -l -m1 -x "to: $sid" "$HOME"/.claude/state/auto-handoff/*.md 2>/dev/null | head -1)
[ -n "$brief" ] || exit 0
link=$(sed -n '2,/^---$/{s/^viewer: //p}' "$brief" | head -1)
[ -n "$link" ] && printf '%s\033[2m↪\033[0m %s' "${out:+$'\n'}" "$link"
exit 0
