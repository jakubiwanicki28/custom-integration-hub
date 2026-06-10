#!/bin/bash
# Auto-deploy: polls GitHub every 30s, pulls and rebuilds on new commits
# Usage: pm2 start deploy/autodeploy.sh --name autodeploy

REPO_DIR="/home/srv/custom-integration-hub"
BRANCH="main"
INTERVAL=30
LOCKFILE="/tmp/autodeploy.lock"
HEALTH_URL="http://127.0.0.1:3100/health"
HEALTH_RETRIES=5
HEALTH_DELAY=3

cd "$REPO_DIR" || exit 1

echo "[autodeploy] Watching $BRANCH every ${INTERVAL}s"

while true; do
  # Fetch latest from remote
  git fetch origin "$BRANCH" --quiet 2>/dev/null

  LOCAL=$(git rev-parse "$BRANCH" 2>/dev/null)
  REMOTE=$(git rev-parse "origin/$BRANCH" 2>/dev/null)

  if [ "$LOCAL" != "$REMOTE" ]; then
    echo "[autodeploy] $(date '+%Y-%m-%d %H:%M:%S') New commit detected: $REMOTE"

    # Prevent concurrent deploys
    if [ -f "$LOCKFILE" ]; then
      echo "[autodeploy] $(date '+%Y-%m-%d %H:%M:%S') Deploy already in progress, skipping"
      sleep "$INTERVAL"
      continue
    fi
    touch "$LOCKFILE"

    # Backup current dist/ for rollback
    if [ -d dist ]; then
      rm -rf dist.bak
      cp -r dist dist.bak
    fi

    DEPLOY_OK=false

    if ! git pull origin "$BRANCH" --ff-only; then
      echo "[autodeploy] $(date '+%Y-%m-%d %H:%M:%S') git pull FAILED"
    elif ! npm ci --silent; then
      echo "[autodeploy] $(date '+%Y-%m-%d %H:%M:%S') npm ci FAILED"
    elif ! npm run build; then
      echo "[autodeploy] $(date '+%Y-%m-%d %H:%M:%S') BUILD FAILED"
    else
      pm2 restart custom-integration-hub

      # Health check: wait for server to bind and respond
      for i in $(seq 1 $HEALTH_RETRIES); do
        sleep "$HEALTH_DELAY"
        if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
          DEPLOY_OK=true
          break
        fi
        echo "[autodeploy] $(date '+%Y-%m-%d %H:%M:%S') Health check attempt $i/$HEALTH_RETRIES failed"
      done
    fi

    if [ "$DEPLOY_OK" = true ]; then
      echo "[autodeploy] $(date '+%Y-%m-%d %H:%M:%S') Deployed successfully: $REMOTE"
      rm -rf dist.bak
    else
      echo "[autodeploy] $(date '+%Y-%m-%d %H:%M:%S') DEPLOY FAILED — rolling back"
      if [ -d dist.bak ]; then
        rm -rf dist
        mv dist.bak dist
        pm2 restart custom-integration-hub
        echo "[autodeploy] $(date '+%Y-%m-%d %H:%M:%S') Rollback complete"
      else
        echo "[autodeploy] $(date '+%Y-%m-%d %H:%M:%S') No dist.bak available for rollback"
      fi
    fi

    rm -f "$LOCKFILE"
  fi

  sleep "$INTERVAL"
done
