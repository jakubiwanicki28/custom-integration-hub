#!/bin/bash
# Auto-deploy: polls GitHub every 30s, pulls and rebuilds on new commits
# Usage: pm2 start deploy/autodeploy.sh --name autodeploy

REPO_DIR="/home/srv/custom-integration-hub"
BRANCH="main"
INTERVAL=30

cd "$REPO_DIR" || exit 1

echo "[autodeploy] Watching $BRANCH every ${INTERVAL}s"

while true; do
  # Fetch latest from remote
  git fetch origin "$BRANCH" --quiet 2>/dev/null

  LOCAL=$(git rev-parse "$BRANCH" 2>/dev/null)
  REMOTE=$(git rev-parse "origin/$BRANCH" 2>/dev/null)

  if [ "$LOCAL" != "$REMOTE" ]; then
    echo "[autodeploy] $(date '+%Y-%m-%d %H:%M:%S') New commit detected: $REMOTE"

    if ! git pull origin "$BRANCH" --ff-only; then
      echo "[autodeploy] $(date '+%Y-%m-%d %H:%M:%S') git pull FAILED"
    elif ! npm install --silent; then
      echo "[autodeploy] $(date '+%Y-%m-%d %H:%M:%S') npm install FAILED"
    elif ! npm run build; then
      echo "[autodeploy] $(date '+%Y-%m-%d %H:%M:%S') BUILD FAILED"
    else
      pm2 restart custom-integration-hub
      echo "[autodeploy] $(date '+%Y-%m-%d %H:%M:%S') Deployed successfully"
    fi
  fi

  sleep "$INTERVAL"
done
