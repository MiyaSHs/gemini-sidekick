@echo off
REM Commit local changes and push to GitHub (main). If the repo is connected to
REM Cloudflare Workers Builds, that push auto-deploys the worker.
REM
REM Secrets are never committed: .dev.vars and .wrangler\ are gitignored.
REM
REM Usage:  scripts\update.bat "optional commit message"
setlocal
cd /d "%~dp0.."

set "MSG=%~1"
if "%MSG%"=="" set "MSG=Update Gemini connector"

git add -A
git commit -m "%MSG%"
git pull --rebase origin main
git push origin main

echo.
echo Pushed to main. If the repo is connected to Cloudflare Workers Builds, it will
echo auto-deploy. Watch: Cloudflare dashboard - your worker - Deployments.
endlocal
