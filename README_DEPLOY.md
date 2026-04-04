# odeaworks.com — Deployment Guide

Static Astro site deployed to Hetzner VPS (connorodea) via GitHub Actions.

## Architecture

```
GitHub Push (main)
    → GitHub Actions CI: npm ci + astro build
    → rsync dist/ → VPS /var/www/odeaworks.com/dist-incoming/
    → SSH: run /var/www/odeaworks.com/deploy.sh
        → rsync dist-incoming/ → html/ (atomic swap)
        → nginx -t
        → systemctl reload nginx
```

## Setup Checklist (10 minutes)

### 1. GitHub Secrets (one-time, per-repo)

Go to: https://github.com/connorodea/odeaworks.com/settings/secrets/actions

| Secret | Value |
|--------|-------|
| `HETZNER_CO_HOST` | `5.161.239.237` |
| `HETZNER_CO_USER` | `root` |
| `HETZNER_CO_SSH_KEY` | Private key for root@hetznerCO |
| `HETZNER_CO_PORT` | `22` (optional) |

To get the private key:
```bash
cat ~/.ssh/id_rsa   # or whatever key your SSH config uses for hetznerCO
```

### 2. VPS Bootstrap (one-time)

```bash
# From your local machine:
scp deploy/nginx-odeaworks.com.conf hetznerCO:/tmp/
scp deploy/nginx-redirects.conf hetznerCO:/tmp/
scp deploy/deploy.sh hetznerCO:/tmp/
ssh hetznerCO 'bash /tmp/vps-bootstrap.sh'
```

### 3. DNS Setup

All domains point to VPS IP `5.161.239.237`.

Run the DNS configuration script (requires whitelisted IP `75.70.129.239`):
```bash
bash deploy/set-dns.sh
```

Or set manually in Namecheap dashboard:

**odeaworks.com:**
- `@` → A → `5.161.239.237`
- `www` → A → `5.161.239.237`

**odeaenterprises.com, odeaengineering.com, odeaco.com:**
- `@` → A → `5.161.239.237`
- `www` → A → `5.161.239.237`

### 4. SSL Certificates

After DNS propagates (5-30 minutes):
```bash
ssh hetznerCO
certbot --nginx -d odeaworks.com -d www.odeaworks.com --redirect --agree-tos -m ssl@odeaworks.com --non-interactive
certbot --nginx -d odeaenterprises.com -d www.odeaenterprises.com --redirect --agree-tos -m ssl@odeaworks.com --non-interactive
certbot --nginx -d odeaengineering.com -d www.odeaengineering.com --redirect --agree-tos -m ssl@odeaworks.com --non-interactive
certbot --nginx -d odeaco.com -d www.odeaco.com --redirect --agree-tos -m ssl@odeaworks.com --non-interactive
```

### 5. First Deploy

Push anything to main, or trigger manually:
```bash
gh workflow run deploy.yml
```

## File Locations on VPS

| Path | Purpose |
|------|---------|
| `/var/www/odeaworks.com/html/` | Nginx webroot (live site) |
| `/var/www/odeaworks.com/dist-incoming/` | rsync landing zone |
| `/var/www/odeaworks.com/deploy.sh` | Deploy script (called by CI) |
| `/etc/nginx/sites-available/odeaworks.com` | Nginx config (main site) |
| `/etc/nginx/sites-available/odea-redirects` | Nginx config (redirect domains) |

## Troubleshooting

**Deploy failed — nginx config error:**
```bash
ssh hetznerCO 'nginx -t'
ssh hetznerCO 'journalctl -u nginx --no-pager -n 50'
```

**Site not loading after deploy:**
```bash
ssh hetznerCO 'ls -la /var/www/odeaworks.com/html/'
ssh hetznerCO 'systemctl status nginx'
```

**SSL certificate renewal:**
```bash
ssh hetznerCO 'certbot renew --dry-run'
# Auto-renews via cron/systemd timer — check with:
ssh hetznerCO 'systemctl status certbot.timer'
```

**Rollback:**
The previous build is not retained on the VPS. To roll back:
1. Revert the commit on main (`git revert HEAD`)
2. Push — CI will rebuild and redeploy the reverted code

## Domains

| Domain | Purpose |
|--------|---------|
| `odeaworks.com` | Primary site |
| `www.odeaworks.com` | Redirects → odeaworks.com |
| `odeaenterprises.com` | Redirects → odeaworks.com |
| `www.odeaenterprises.com` | Redirects → odeaworks.com |
| `odeaengineering.com` | Redirects → odeaworks.com |
| `www.odeaengineering.com` | Redirects → odeaworks.com |
| `odeaco.com` | Redirects → odeaworks.com |
| `www.odeaco.com` | Redirects → odeaworks.com |
