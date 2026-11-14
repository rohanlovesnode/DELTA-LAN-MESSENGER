#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or newer is required. Install Node.js before running this script." >&2
  exit 1
fi
NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js 18 or newer is required (found $(node --version))." >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "OpenSSL is required. Install it with: sudo apt install openssl" >&2
  exit 1
fi

npm ci --omit=dev
mkdir -p data/uploads certs
if [ ! -f .env ]; then
  cp .env.example .env
fi
./scripts/generate-cert.sh 192.168.101.50
echo "Install complete. Review .env and run: npm start"
