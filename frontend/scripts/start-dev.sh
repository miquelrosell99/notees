#!/bin/sh
# Development entrypoint: start nginx (HTTP + HTTPS reverse proxy) and Vite.

set -e

CERT=/tmp/notees-dev.crt
KEY=/tmp/notees-dev.key

if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
  echo "Generating self-signed certificate for HTTPS dev server..."
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout "$KEY" -out "$CERT" \
    -subj "/CN=notees-dev" \
    -addext "subjectAltName=DNS:localhost,DNS:atlas,DNS:atlas.ts.net,IP:127.0.0.1"
fi

nginx -c /app/nginx.dev.conf

exec npm run dev -- --host 0.0.0.0 --port 5174
