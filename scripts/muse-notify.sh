#!/bin/sh
set -eu

picoclaw_bin=${PICOCLAW_BIN:-/vol1/picoclaw/bin/picoclaw}

if [ "$#" -eq 0 ]; then
  if [ -t 0 ]; then
    echo "Usage: muse-notify 'message' [notify options]" >&2
    echo "       command | muse-notify" >&2
    exit 2
  fi
  exec "$picoclaw_bin" --no-color notify --file -
fi

case "$1" in
  -*) exec "$picoclaw_bin" --no-color notify "$@" ;;
  *) message=$1; shift; exec "$picoclaw_bin" --no-color notify --message "$message" "$@" ;;
esac
