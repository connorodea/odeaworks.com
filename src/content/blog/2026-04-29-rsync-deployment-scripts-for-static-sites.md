---
title: "Building Robust rsync Deployment Scripts for Static Sites"
description: "Learn to build production-ready rsync deployment scripts for static sites with error handling, rollback, and monitoring."
pubDate: 2026-04-29
category: devops-infrastructure
tags: [rsync, deployment, static-sites, bash, devops]
targetKeyword: "rsync deployment scripts for static sites"
---

Static site deployment seems straightforward until you hit production. We've built dozens of rsync deployment scripts for static sites across our projects at Odea Works, from simple marketing sites to complex documentation portals. The difference between a basic rsync command and a production-ready deployment script is error handling, rollback capabilities, and proper monitoring.

Most developers start with a simple `rsync -av build/ server:/var/www/site/` and call it done. That works until something breaks at 2 AM, you need to roll back a deployment, or you're managing multiple environments. After deploying everything from our QuickLotz WMS documentation site to various client marketing portals, we've learned what separates reliable deployments from deployment disasters.

## The Foundation: A Basic rsync Deployment Script

Let's start with the fundamentals. A basic rsync deployment script for static sites needs to handle file transfers, preserve permissions, and provide some feedback. Here's our starting point:

```bash
#!/bin/bash

# Basic rsync deployment script
set -euo pipefail

# Configuration
SOURCE_DIR="./build"
REMOTE_USER="deploy"
REMOTE_HOST="production.example.com"
REMOTE_PATH="/var/www/html"
SSH_KEY="~/.ssh/deploy_key"

# Basic deployment
rsync -avz --delete \
    -e "ssh -i $SSH_KEY" \
    "$SOURCE_DIR/" \
    "$REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH"

echo "Deployment complete!"
```

This basic script works, but it's missing crucial production features. Let's build something more robust.

## Production-Ready rsync Deployment Script

Here's a comprehensive rsync deployment script we use for static sites in production:

```bash
#!/bin/bash

# Production rsync deployment script for static sites
# Usage: ./deploy.sh [staging|production]

set -euo pipefail

# Script configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="/tmp/deploy-$(date +%Y%m%d-%H%M%S).log"
BACKUP_DIR="/var/backups/site-deployments"
MAX_BACKUPS=10

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Logging function
log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

error_exit() {
    echo -e "${RED}ERROR: $1${NC}" >&2
    log "ERROR: $1"
    exit 1
}

success() {
    echo -e "${GREEN}$1${NC}"
    log "SUCCESS: $1"
}

warning() {
    echo -e "${YELLOW}WARNING: $1${NC}"
    log "WARNING: $1"
}

# Environment configuration
setup_environment() {
    local env=$1
    
    case $env in
        staging)
            REMOTE_HOST="staging.example.com"
            REMOTE_PATH="/var/www/staging"
            ;;
        production)
            REMOTE_HOST="production.example.com"
            REMOTE_PATH="/var/www/html"
            ;;
        *)
            error_exit "Invalid environment. Use 'staging' or 'production'"
            ;;
    esac
    
    # Common configuration
    SOURCE_DIR="./dist"
    REMOTE_USER="deploy"
    SSH_KEY="$HOME/.ssh/deploy_key"
    RSYNC_EXCLUDES="$SCRIPT_DIR/rsync-excludes.txt"
}

# Pre-deployment checks
pre_deployment_checks() {
    log "Running pre-deployment checks..."
    
    # Check if source directory exists
    if [[ ! -d "$SOURCE_DIR" ]]; then
        error_exit "Source directory $SOURCE_DIR does not exist. Run build first."
    fi
    
    # Check if source directory has content
    if [[ -z "$(ls -A "$SOURCE_DIR" 2>/dev/null)" ]]; then
        error_exit "Source directory $SOURCE_DIR is empty"
    fi
    
    # Check SSH key
    if [[ ! -f "$SSH_KEY" ]]; then
        error_exit "SSH key not found: $SSH_KEY"
    fi
    
    # Test SSH connection
    if ! ssh -i "$SSH_KEY" -o ConnectTimeout=10 -o BatchMode=yes \
         "$REMOTE_USER@$REMOTE_HOST" "echo 'SSH connection test successful'" &>/dev/null; then
        error_exit "Cannot connect to $REMOTE_HOST via SSH"
    fi
    
    # Check remote directory exists
    if ! ssh -i "$SSH_KEY" "$REMOTE_USER@$REMOTE_HOST" \
         "test -d $(dirname "$REMOTE_PATH")"; then
        error_exit "Remote parent directory does not exist: $(dirname "$REMOTE_PATH")"
    fi
    
    success "Pre-deployment checks passed"
}

# Create backup of current deployment
create_backup() {
    log "Creating backup of current deployment..."
    
    local backup_name="backup-$(date +%Y%m%d-%H%M%S)"
    local backup_path="$BACKUP_DIR/$backup_name"
    
    # Create backup directory on remote server if it doesn't exist
    ssh -i "$SSH_KEY" "$REMOTE_USER@$REMOTE_HOST" \
        "mkdir -p $BACKUP_DIR"
    
    # Create backup if remote path exists and has content
    if ssh -i "$SSH_KEY" "$REMOTE_USER@$REMOTE_HOST" \
       "test -d $REMOTE_PATH && test -n \"\$(ls -A $REMOTE_PATH 2>/dev/null)\""; then
        
        ssh -i "$SSH_KEY" "$REMOTE_USER@$REMOTE_HOST" \
            "cp -r $REMOTE_PATH $backup_path"
        
        success "Backup created: $backup_name"
        echo "$backup_name" > /tmp/last_backup_name
    else
        warning "No existing deployment found to backup"
    fi
}

# Cleanup old backups
cleanup_backups() {
    log "Cleaning up old backups..."
    
    ssh -i "$SSH_KEY" "$REMOTE_USER@$REMOTE_HOST" "
        cd $BACKUP_DIR 2>/dev/null || exit 0
        ls -t backup-* 2>/dev/null | tail -n +$((MAX_BACKUPS + 1)) | xargs rm -rf
    "
}

# Perform the deployment
deploy() {
    log "Starting deployment to $ENVIRONMENT..."
    
    # Rsync options explained:
    # -a: archive mode (recursive, preserve permissions, times, etc.)
    # -v: verbose
    # -z: compress during transfer
    # --delete: delete files on destination that don't exist in source
    # --delete-excluded: delete excluded files from destination
    # --partial: keep partial files for resume capability
    # --partial-dir: store partial files in specific directory
    # --exclude-from: read exclude patterns from file
    # --stats: show transfer statistics
    # --human-readable: output numbers in human-readable format
    
    local rsync_opts=(
        -avz
        --delete
        --delete-excluded
        --partial
        --partial-dir=.rsync-partial
        --stats
        --human-readable
        --progress
    )
    
    # Add exclude file if it exists
    if [[ -f "$RSYNC_EXCLUDES" ]]; then
        rsync_opts+=(--exclude-from="$RSYNC_EXCLUDES")
    fi
    
    # Add SSH options
    rsync_opts+=(-e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null")
    
    # Perform the sync
    if rsync "${rsync_opts[@]}" \
       "$SOURCE_DIR/" \
       "$REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH" \
       2>&1 | tee -a "$LOG_FILE"; then
        success "Deployment completed successfully"
    else
        error_exit "Rsync deployment failed"
    fi
}

# Post-deployment verification
post_deployment_verification() {
    log "Running post-deployment verification..."
    
    # Check if key files exist on remote
    local key_files=("index.html")
    
    for file in "${key_files[@]}"; do
        if ! ssh -i "$SSH_KEY" "$REMOTE_USER@$REMOTE_HOST" \
             "test -f $REMOTE_PATH/$file"; then
            error_exit "Key file missing after deployment: $file"
        fi
    done
    
    # Set correct permissions
    ssh -i "$SSH_KEY" "$REMOTE_USER@$REMOTE_HOST" \
        "find $REMOTE_PATH -type f -exec chmod 644 {} \; && \
         find $REMOTE_PATH -type d -exec chmod 755 {} \;"
    
    success "Post-deployment verification passed"
}

# Rollback function
rollback() {
    if [[ ! -f /tmp/last_backup_name ]]; then
        error_exit "No backup found for rollback"
    fi
    
    local backup_name=$(cat /tmp/last_backup_name)
    local backup_path="$BACKUP_DIR/$backup_name"
    
    log "Rolling back to backup: $backup_name"
    
    ssh -i "$SSH_KEY" "$REMOTE_USER@$REMOTE_HOST" \
        "rm -rf $REMOTE_PATH && cp -r $backup_path $REMOTE_PATH"
    
    success "Rollback completed"
}

# Main deployment function
main() {
    local environment=${1:-}
    
    if [[ "$environment" == "rollback" ]]; then
        rollback
        exit 0
    fi
    
    if [[ -z "$environment" ]]; then
        echo "Usage: $0 [staging|production|rollback]"
        exit 1
    fi
    
    ENVIRONMENT=$environment
    setup_environment "$environment"
    
    log "=== Starting deployment to $environment ==="
    log "Source: $SOURCE_DIR"
    log "Destination: $REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH"
    
    # Confirmation for production
    if [[ "$environment" == "production" ]]; then
        echo -e "${YELLOW}You are about to deploy to PRODUCTION.${NC}"
        read -p "Are you sure? (yes/no): " confirm
        if [[ "$confirm" != "yes" ]]; then
            echo "Deployment cancelled."
            exit 0
        fi
    fi
    
    pre_deployment_checks
    create_backup
    deploy
    post_deployment_verification
    cleanup_backups
    
    success "=== Deployment to $environment completed successfully ==="
    log "Log file: $LOG_FILE"
}

# Handle script termination
cleanup_on_exit() {
    if [[ $? -ne 0 ]]; then
        error_exit "Deployment failed. Check log file: $LOG_FILE"
    fi
}

trap cleanup_on_exit EXIT

# Run main function
main "$@"
```

## Essential Configuration Files

Your deployment script needs supporting configuration files. Create an `rsync-excludes.txt` file to specify what should never be deployed:

```
.git/
.gitignore
.env*
.DS_Store
Thumbs.db
node_modules/
*.log
.rsync-partial/
deploy.sh
rsync-excludes.txt
README.md
*.md
package*.json
yarn.lock
.github/
.vscode/
*.tmp
*.swp
*~
```

## Advanced Features for Production

### Health Checks and Monitoring Integration

Add health checks to verify your deployment actually worked:

```bash
# Health check function
health_check() {
    local url="https://${REMOTE_HOST}"
    local max_attempts=5
    local attempt=1
    
    log "Running health check against $url..."
    
    while [[ $attempt -le $max_attempts ]]; do
        if curl -f -s -o /dev/null --max-time 10 "$url"; then
            success "Health check passed (attempt $attempt/$max_attempts)"
            return 0
        fi
        
        warning "Health check failed (attempt $attempt/$max_attempts)"
        sleep 10
        ((attempt++))
    done
    
    error_exit "Health check failed after $max_attempts attempts"
}
```

### Slack Notifications

Integrate with Slack to notify your team about deployments:

```bash
send_slack_notification() {
    local status=$1
    local message=$2
    local webhook_url="$SLACK_WEBHOOK_URL"
    
    if [[ -n "$webhook_url" ]]; then
        curl -X POST -H 'Content-type: application/json' \
            --data "{\"text\":\"🚀 Deployment $status: $message\"}" \
            "$webhook_url" &>/dev/null || true
    fi
}
```

### Database Migration Integration

For sites with build-time data processing, add database migration checks:

```bash
run_migrations() {
    log "Checking for required migrations..."
    
    # Example: Check if content hash changed
    local content_hash=$(find "$SOURCE_DIR" -type f -exec sha256sum {} \; | sha256sum | cut -d' ' -f1)
    local remote_hash=$(ssh -i "$SSH_KEY" "$REMOTE_USER@$REMOTE_HOST" \
                       "cat $REMOTE_PATH/.content-hash 2>/dev/null || echo 'none'")
    
    if [[ "$content_hash" != "$remote_hash" ]]; then
        log "Content changed, running post-deployment tasks..."
        
        # Clear CDN cache, update search index, etc.
        ssh -i "$SSH_KEY" "$REMOTE_USER@$REMOTE_HOST" \
            "echo '$content_hash' > $REMOTE_PATH/.content-hash"
    fi
}
```

## Performance Optimization Techniques

### Parallel Transfers

For large sites, enable parallel transfers:

```bash
# Add to rsync options for better performance
rsync_opts+=(
    --partial-dir=.rsync-partial
    --inplace
    --no-whole-file
    --compress-level=6
)
```

### Bandwidth Limiting

Prevent deployment from saturating your connection:

```bash
# Add bandwidth limiting (in KB/s)
rsync_opts+=(--bwlimit=1000)
```

### Checksum-Based Transfers

For sites where timestamp comparison isn't reliable:

```bash
# Use checksums instead of timestamps
rsync_opts+=(--checksum)
```

## Integration with CI/CD Pipelines

We integrate these rsync deployment scripts with GitHub Actions for our projects. Here's how it connects with our [GitHub Actions CI/CD tutorial](/blog/2026-04-05-github-actions-ci-cd-tutorial-astro):

```yaml
# .github/workflows/deploy.yml
name: Deploy Static Site

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Build site
        run: npm run build
        
      - name: Setup SSH key
        run: |
          mkdir -p ~/.ssh
          echo "${{ secrets.DEPLOY_SSH_KEY }}" > ~/.ssh/deploy_key
          chmod 600 ~/.ssh/deploy_key
          
      - name: Deploy to staging
        if: github.ref == 'refs/heads/develop'
        run: ./scripts/deploy.sh staging
        
      - name: Deploy to production
        if: github.ref == 'refs/
