#!/bin/sh
# Build for the e2e run, serialised and skipped when the output is newer than every input, so parallel runs
# (E2E_PORT=...) in one checkout neither race on .svelte-kit nor rebuild under a running sibling server.
BUILD='
out=.svelte-kit/cloudflare/_worker.js
if [ -f "$out" ] && [ -z "$(find src static _headers package.json package-lock.json svelte.config.js vite.config.ts wrangler.jsonc scripts/site-adapter.ts -newer "$out" -print -quit 2>/dev/null)" ]; then
  echo "e2e-build: output is current, skipping build"
else
  npm run build
fi'
if command -v flock >/dev/null 2>&1; then
  exec flock .svelte-kit-build.lock sh -c "$BUILD"
fi
# macOS has no flock: an atomic mkdir lock instead, removed on exit or interrupt.
LOCK=.svelte-kit-build.lock.d
until mkdir "$LOCK" 2>/dev/null; do sleep 1; done
trap 'rmdir "$LOCK"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
sh -c "$BUILD"
