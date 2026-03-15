# Daily Kickstart Claude

Automated haiku generator running on Raspberry Pi, powered by Claude AI.

## What It Does

Generates and commits inspirational haikus 4 times daily (6am, 12pm, 6pm, 10pm) to `haiku.txt`, with built-in sync health checks and operator commands.

## How It Works

1. Cron job triggers `kickstart-cli.sh` on schedule
2. Script fetches and rebases before generation so the branch stays current
3. Claude CLI generates a haiku
4. Script appends the haiku with a timestamp to `haiku.txt`
5. Script commits and pushes to GitHub
6. Separate health checks verify freshness, sync state, and recent failures

## Setup (Raspberry Pi)

### Prerequisites

- Raspberry Pi with Raspberry Pi OS Lite
- Network connection (WiFi/Ethernet)
- Claude subscription (for Claude CLI authentication)
- GitHub account

### Installation

**1. SSH into your Pi:**
```bash
ssh user@raspberrypi.local
```

**2. Install dependencies:**
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl
```

**3. Install Node.js:**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

**4. Install Claude CLI:**
```bash
sudo npm install -g @anthropic-ai/claude-code
```

**5. Authenticate Claude CLI:**
```bash
claude auth login
```

**6. Configure Git:**
```bash
git config --global user.name "Your Name"
git config --global user.email "your@email.com"
```

**7. Setup GitHub authentication:**

Recommended: use SSH so cron can pull and push non-interactively.

```bash
ssh-keygen -t ed25519 -C "your@email.com"
cat ~/.ssh/id_ed25519.pub
```

Add the public key to GitHub, then switch the repo to SSH and verify access:

```bash
git remote set-url origin git@github.com:theanhgen/daily-kickstart-claude.git
ssh -T git@github.com
```

HTTPS with a fine-grained Personal Access Token also works, but if you enable `credential.useHttpPath=true` the credential entry must include the full repo path:

```bash
git config --global credential.helper store
git config --global credential.useHttpPath true
echo 'https://YOUR_USERNAME:YOUR_TOKEN@github.com/theanhgen/daily-kickstart-claude.git' > ~/.git-credentials
chmod 600 ~/.git-credentials
```

**8. Clone this repository:**
```bash
cd ~
git clone git@github.com:theanhgen/daily-kickstart-claude.git
cd daily-kickstart-claude
chmod +x kickstart-cli.sh
```

If you are using the HTTPS token flow instead of SSH, clone with the HTTPS URL instead.

**9. Test the script:**
```bash
./kickstart-cli.sh
./status.sh
./healthcheck.sh
cat haiku.txt
```

**10. Optional notifications:**
```bash
cp .notify.env.example .notify.env
```

Edit `.notify.env` and set an ntfy topic:
```bash
NOTIFY_NTFY_TOPIC="daily-kickstart-claude"
```

Test it:
```bash
./notify.sh info "Daily Kickstart test" "Notifications are working."
```

**11. Setup automation:**
```bash
crontab -e
```

Add these lines:
```cron
# Daily Kickstart Claude - 4x daily haikus
0 6 * * * /home/YOUR_USER/daily-kickstart-claude/cron-kickstart.sh
0 12 * * * /home/YOUR_USER/daily-kickstart-claude/cron-kickstart.sh
0 18 * * * /home/YOUR_USER/daily-kickstart-claude/cron-kickstart.sh
0 22 * * * /home/YOUR_USER/daily-kickstart-claude/cron-kickstart.sh

# Daily sync pass at 21:21 to flush pending local commits
21 21 * * * /home/YOUR_USER/daily-kickstart-claude/cron-update.sh

# Health checks every 30 minutes
15,45 * * * * /home/YOUR_USER/daily-kickstart-claude/cron-healthcheck.sh

# Log rotation every 3 days at midnight
0 0 */3 * * /home/YOUR_USER/daily-kickstart-claude/cron-rotate-logs.sh
```

Replace `YOUR_USER` with your actual username (e.g., `pi` or `thevetev`).

The main script fetches before generation and pushes after a successful commit. `cron-update.sh` now calls `sync-now.sh`, which is the manual and scheduled recovery path for pending local commits.

## Files

- **`session_prompt.txt`** - The prompt sent to Claude (currently: "Generate a haiku.")
- **`haiku.txt`** - Generated haikus with timestamps
- **`kickstart-cli.sh`** - Main script that generates and commits haikus
- **`sync-now.sh`** - Safe fetch/rebase/push command without generating a new haiku
- **`status.sh`** - Operator status view for sync state, last run state, and recent logs
- **`healthcheck.sh`** - Health monitor for freshness, divergence, and recent failures
- **`notify.sh`** - Optional ntfy notifier used by the health check
- **`.notify.env.example`** - Example notification configuration
- **`.gitignore`** - Git ignore rules

## Customization

**Change the prompt:**
```bash
echo "Your new prompt here" > session_prompt.txt
git add session_prompt.txt
git commit -m "Update prompt"
git push
```

**Change schedule:**
Edit crontab with `crontab -e` and modify the times.

## Monitoring

**View haiku generation logs:**
```bash
tail -f ~/kickstart.log
```

**View auto-update logs:**
```bash
tail -f ~/update.log
```

**View healthcheck logs:**
```bash
tail -f ~/healthcheck.log
```

**Check recent haikus:**
```bash
tail -30 ~/daily-kickstart-claude/haiku.txt
```

**Verify cron schedule:**
```bash
crontab -l
```

**Manual run:**
```bash
cd ~/daily-kickstart-claude && ./kickstart-cli.sh
```

**Check current status:**
```bash
cd ~/daily-kickstart-claude && ./status.sh
```

**Push pending commits without generating a haiku:**
```bash
cd ~/daily-kickstart-claude && ./sync-now.sh
```

## Troubleshooting

**Script fails:**
```bash
# Check Claude CLI
claude --version

# Test Claude authentication
claude -p "Hello"

# Check logs
tail ~/kickstart.log
```

**Git push fails:**
```bash
# Test repo access
cd ~/daily-kickstart-claude
./sync-now.sh

# Verify SSH authentication
ssh -T git@github.com
```

**Healthcheck fails:**
```bash
cd ~/daily-kickstart-claude
./healthcheck.sh
./status.sh

# Verify notification config
cat .notify.env
```

**Cron not running:**
```bash
# Check cron service
sudo systemctl status cron

# View cron logs
grep CRON /var/log/syslog
```

## License

Public domain. Use as you wish.
