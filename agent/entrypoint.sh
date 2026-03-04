#!/bin/bash

# Mount R2 bucket at ~/.claude/projects/ for Agent SDK session persistence
# Session files survive container replacement, enabling zero-downtime deploys

HOME="${HOME:-/home/agent}"
MOUNT_POINT="$HOME/.claude/projects"
BUCKET="product-engineer-sessions"

# Check if R2 credentials are provided
if [[ -n "$R2_ACCESS_KEY_ID" && -n "$R2_SECRET_ACCESS_KEY" && -n "$CF_ACCOUNT_ID" ]]; then
  echo "[Entrypoint] Mounting R2 bucket for session persistence..."

  # Create mount point
  mkdir -p "$MOUNT_POINT"

  # Write s3fs credentials
  echo "$R2_ACCESS_KEY_ID:$R2_SECRET_ACCESS_KEY" > "$HOME/.passwd-s3fs"
  chmod 600 "$HOME/.passwd-s3fs"

  # Mount R2 bucket via s3fs — graceful fallback if FUSE not available
  # Cloudflare R2 S3-compatible endpoint format: https://<account-id>.r2.cloudflarestorage.com
  if s3fs "$BUCKET" "$MOUNT_POINT" \
    -o passwd_file="$HOME/.passwd-s3fs" \
    -o url="https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com" \
    -o use_path_request_style \
    -o umask=0077 \
    -o uid=$(id -u) \
    -o gid=$(id -g); then
    echo "[Entrypoint] R2 bucket mounted at $MOUNT_POINT"
  else
    echo "[Entrypoint] WARNING: R2 FUSE mount failed — session persistence disabled. Agent will start fresh on container restart."
    rm -f "$HOME/.passwd-s3fs"
  fi
else
  echo "[Entrypoint] R2 credentials not provided — session persistence disabled (dev mode?)"
fi

# Start the agent server
exec bun run /app/src/server.ts
