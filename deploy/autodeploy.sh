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

    git pull origin "$BRANCH" --ff-only
    npm install --omit=dev --silent
    npm run build

    if [ $? -eq 0 ]; then
      pm2 restart custom-integration-hub
      echo "[autodeploy] $(date '+%Y-%m-%d %H:%M:%S') Deployed successfully"
    else
      echo "[autodeploy] $(date '+%Y-%m-%d %H:%M:%S') BUILD FAILED — not restarting"
    fi
  fi

  sleep "$INTERVAL"
done
