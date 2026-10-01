#!/usr/bin/env bash
# Install the product's dependencies with the package manager its lockfile names. Run it from the
# product's directory:
#
#   bash .sdlc/bin/install-deps.sh [--ignore-scripts]
#
# Every job that installs the product ran `npm ci` or `npm install`, so a Yarn or pnpm repository
# could not be planned, built or tested at all — Actual Budget's `workspace:` versions, which npm
# refuses, stopped it before a single check. The exit status is the install's.
set -uo pipefail
ignore=""
[ "${1:-}" = "--ignore-scripts" ] && ignore=1

# Yarn and pnpm come from the version the repository pins (packageManager, or Yarn's yarnPath).
# corepack ships with Node; if enabling it fails, the runner's own yarn still honours yarnPath.
use_corepack() { corepack enable >/dev/null 2>&1 || true; }

if [ -f pnpm-lock.yaml ]; then
  use_corepack
  echo "installing with pnpm"
  exec pnpm install --frozen-lockfile ${ignore:+--ignore-scripts}
elif [ -f yarn.lock ]; then
  use_corepack
  if yarn --version 2>/dev/null | grep -q '^1\.'; then
    echo "installing with yarn (classic)"
    exec yarn install --frozen-lockfile --non-interactive ${ignore:+--ignore-scripts}
  fi
  echo "installing with yarn $(yarn --version 2>/dev/null)"
  if [ -n "$ignore" ]; then export YARN_ENABLE_SCRIPTS=false; fi
  exec yarn install --immutable
elif [ -f package-lock.json ]; then
  echo "installing with npm ci"
  exec npm ci --no-audit --no-fund ${ignore:+--ignore-scripts}
elif [ -f package.json ]; then
  echo "installing with npm install (no lockfile)"
  exec npm install --no-audit --no-fund ${ignore:+--ignore-scripts}
else
  echo "no package.json here — nothing to install"
fi
