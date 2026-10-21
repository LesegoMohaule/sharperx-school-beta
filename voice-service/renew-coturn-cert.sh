#!/bin/sh
set -eu

CERT_NAME=api.46.225.173.118.nip.io
LIVE_DIR="/etc/letsencrypt/live/$CERT_NAME"
TARGET_DIR=/etc/turnserver/tls

install -d -o root -g turnserver -m 0750 "$TARGET_DIR"
install -o root -g turnserver -m 0640 "$LIVE_DIR/fullchain.pem" "$TARGET_DIR/fullchain.pem"
install -o root -g turnserver -m 0640 "$LIVE_DIR/privkey.pem" "$TARGET_DIR/privkey.pem"
systemctl restart coturn
