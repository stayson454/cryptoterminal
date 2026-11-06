#!/usr/bin/env bash
# =============================================================================
#  CryptoTerminal — установка и обновление на VPS
#  (Ubuntu 22.04 / 24.04, например Oracle Cloud Always Free).
#
#  Что делает:
#    • ставит Python 3, git и веб-сервер Caddy (автоматический HTTPS);
#    • кладёт код в /opt/cryptoterminal (повторный запуск — обновление);
#    • создаёт службу cryptoterminal (server.py, автозапуск, перезапуск при сбое);
#    • выдаёт HTTPS-адрес вида https://1-2-3-4.sslip.io (свой домен: CT_HOST=…);
#    • открывает порты 80/443 во встроенном файрволе Ubuntu.
#
#  Запуск:   curl -fsSL https://raw.githubusercontent.com/stayson454/cryptoterminal/main/deploy/setup.sh | sudo bash
#  Ключ Binance (только чтение) кладётся вручную в /opt/cryptoterminal/config.local.json
# =============================================================================
set -euo pipefail

REPO_URL="${CT_REPO:-https://github.com/stayson454/cryptoterminal.git}"
APP_DIR=/opt/cryptoterminal
APP_USER=cryptoterminal
ORIGINS="${CT_ALLOW_ORIGINS:-https://stayson454.github.io}"

say() { printf '\n\033[1;33m== %s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Запустите через sudo:  curl -fsSL …/setup.sh | sudo bash"
  exit 1
fi

say "Пакеты: python3, git, curl"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y python3 git curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https
echo iptables-persistent iptables-persistent/autosave_v4 boolean true | debconf-set-selections
echo iptables-persistent iptables-persistent/autosave_v6 boolean true | debconf-set-selections
apt-get install -y iptables-persistent netfilter-persistent

if ! command -v caddy >/dev/null 2>&1; then
  say "Веб-сервер Caddy (HTTPS через Let's Encrypt)"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

say "Пользователь службы"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

say "Код CryptoTerminal → $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -c safe.directory="$APP_DIR" -C "$APP_DIR" pull --ff-only
else
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi
if [ ! -f "$APP_DIR/config.local.json" ]; then
  printf '{\n  "binance_api_key": "",\n  "binance_api_secret": ""\n}\n' > "$APP_DIR/config.local.json"
fi
mkdir -p "$APP_DIR/data"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$APP_DIR/config.local.json"

say "Служба cryptoterminal"
cat > /etc/systemd/system/cryptoterminal.service <<EOF
[Unit]
Description=CryptoTerminal (сайт + сбор пула маржи Binance)
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=CT_ALLOW_ORIGINS=$ORIGINS
Environment=PYTHONUNBUFFERED=1
ExecStart=/usr/bin/python3 $APP_DIR/server.py --host 127.0.0.1 --port 8765
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable cryptoterminal >/dev/null
systemctl restart cryptoterminal

say "HTTPS-адрес"
IP="$(curl -fsS --max-time 10 https://api.ipify.org || curl -fsS --max-time 10 https://ifconfig.me)"
HOST="${CT_HOST:-$(echo "$IP" | tr . -).sslip.io}"
cat > /etc/caddy/Caddyfile <<EOF
$HOST {
  encode gzip
  reverse_proxy 127.0.0.1:8765
}
EOF

say "Файрвол Ubuntu: порты 80 и 443"
for p in 80 443; do
  iptables -C INPUT -p tcp --dport "$p" -m state --state NEW -j ACCEPT 2>/dev/null \
    || iptables -I INPUT -p tcp --dport "$p" -m state --state NEW -j ACCEPT
done
netfilter-persistent save >/dev/null 2>&1 || true

systemctl enable caddy >/dev/null
systemctl restart caddy

say "Проверка"
sleep 3
if curl -fsS --max-time 5 http://127.0.0.1:8765/api/margin/status >/dev/null; then
  echo "server.py работает."
else
  echo "server.py не отвечает — смотрите журнал: sudo journalctl -u cryptoterminal -n 50"
fi

KEY_SET=$(python3 -c "import json;c=json.load(open('$APP_DIR/config.local.json'));print('yes' if c.get('binance_api_key') and c.get('binance_api_secret') else 'no')")

cat <<EOF

=============================================================================
 Готово.
   Сайт с займами и пулом:   https://$HOST
   (первый заход может занять до минуты — Caddy получает сертификат)
   Публичный IP:             $IP

 Адрес для онлайн-версии на GitHub Pages (site-config.js → marginApi):
   https://$HOST
EOF
if [ "$KEY_SET" = "no" ]; then
cat <<EOF

 Осталось положить ключ Binance (только чтение):
   sudo nano $APP_DIR/config.local.json
   sudo systemctl restart cryptoterminal
EOF
fi
cat <<EOF

 Полезное:
   журнал сервера:   sudo journalctl -u cryptoterminal -f
   обновить сайт:    curl -fsSL https://raw.githubusercontent.com/stayson454/cryptoterminal/main/deploy/setup.sh | sudo bash
=============================================================================
EOF
