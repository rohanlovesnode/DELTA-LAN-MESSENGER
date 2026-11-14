#!/usr/bin/env bash
set -euo pipefail

LAN_IP="${1:-192.168.101.50}"
CERT_DIR="${CERT_DIR:-./certs}"
mkdir -p "$CERT_DIR"

openssl req -x509 -nodes -days 825 -newkey rsa:3072 \
  -keyout "$CERT_DIR/server.key" \
  -out "$CERT_DIR/server.crt" \
  -subj "/CN=$LAN_IP" \
  -addext "subjectAltName=IP:$LAN_IP"
chmod 600 "$CERT_DIR/server.key"
echo "Created a self-signed certificate for $LAN_IP in $CERT_DIR."
echo "For a trusted browser connection, install server.crt as a trusted root on each client."
