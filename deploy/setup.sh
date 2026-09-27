#!/bin/sh
# One-time setup of a fresh Ubuntu 24.04 VPS for FitFileSize.
# Run as the default user (ubuntu), which has sudo:
#
#   curl -fsSL https://raw.githubusercontent.com/Gautamstar/fitfilesize/main/deploy/setup.sh | sh
#
# Safe to run again: every step checks before it changes anything.
set -eu

REPO=https://github.com/Gautamstar/fitfilesize.git
DIR=/opt/fitfilesize

echo "== system updates"
sudo apt-get update -q
sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -yq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -yq ca-certificates curl git ufw unattended-upgrades fail2ban

echo "== automatic security updates"
sudo dpkg-reconfigure -f noninteractive unattended-upgrades

echo "== firewall: SSH only (the site comes in through the tunnel, not a port)"
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw --force enable

echo "== SSH: keys only, once a key is installed"
if [ -s "$HOME/.ssh/authorized_keys" ]; then
  echo "PasswordAuthentication no" | sudo tee /etc/ssh/sshd_config.d/10-keys-only.conf >/dev/null
  echo "PermitRootLogin no" | sudo tee -a /etc/ssh/sshd_config.d/10-keys-only.conf >/dev/null
  sudo sshd -t
  # 24.04 starts sshd per connection (ssh.socket), so there may be nothing to reload.
  sudo systemctl try-reload-or-restart ssh
else
  echo "   no key in ~/.ssh/authorized_keys yet: password login left on"
fi

echo "== 2 GB swap, so a memory spike slows down instead of killing"
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null
fi

echo "== Docker, from Docker's own apt repository"
if ! command -v docker >/dev/null; then
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -q
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER"
fi

echo "== the code"
if [ ! -d "$DIR/.git" ]; then
  sudo git clone "$REPO" "$DIR"
  sudo chown -R "$USER:$USER" "$DIR"
fi
if [ ! -f "$DIR/deploy/.env" ]; then
  cp "$DIR/deploy/.env.example" "$DIR/deploy/.env"
  chmod 600 "$DIR/deploy/.env"
fi

echo "== watchdog: restart a container that hangs (Docker only restarts ones that exit)"
sudo tee /etc/systemd/system/fitfilesize-watchdog.service >/dev/null <<UNIT
[Unit]
Description=Restart FitFileSize containers that /health reports stuck
After=docker.service

[Service]
Type=oneshot
ExecStart=$DIR/deploy/watchdog.sh
UNIT
sudo tee /etc/systemd/system/fitfilesize-watchdog.timer >/dev/null <<UNIT
[Unit]
Description=Check FitFileSize health every minute

[Timer]
OnBootSec=3min
OnUnitActiveSec=1min

[Install]
WantedBy=timers.target
UNIT

echo "== autodeploy: deploy main within two minutes of a merge"
sudo tee /etc/systemd/system/fitfilesize-autodeploy.service >/dev/null <<UNIT
[Unit]
Description=Deploy FitFileSize when main has new commits
After=docker.service network-online.target

[Service]
Type=oneshot
User=$USER
StateDirectory=fitfilesize
ExecStart=$DIR/deploy/autodeploy.sh
UNIT
sudo tee /etc/systemd/system/fitfilesize-autodeploy.timer >/dev/null <<UNIT
[Unit]
Description=Check for new FitFileSize commits every two minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now fitfilesize-watchdog.timer fitfilesize-autodeploy.timer

echo
echo "Done. Next:"
echo "  1. Log out and back in (so Docker works without sudo)."
echo "  2. Put the tunnel token in $DIR/deploy/.env"
echo "  3. Run $DIR/deploy/deploy.sh (after that, merges to main deploy themselves)"
