#!/usr/bin/env bash
# Commit local changes and push to GitHub (main). If the repo is connected to
# Cloudflare Workers Builds, that push auto-deploys the worker.
#
# Secrets are never committed: .dev.vars and .wrangler/ are gitignored.
#
# Usage:  bash scripts/update.sh "optional commit message"
set -euo pipefail
cd "$(dirname "$0")/.."

msg="${1:-Update Gemini connector}"

git add -A
if git diff --cached --quiet; then
  echo "Nothing new to commit."
else
  git commit -m "$msg"
fi

# Reconcile with any remote changes first so the push isn't rejected, then push.
git pull --rebase origin main
git push origin main

echo
echo "Pushed to main. If the repo is connected to Cloudflare Workers Builds, it will"
echo "auto-deploy. Watch: Cloudflare dashboard -> your worker -> Deployments."
