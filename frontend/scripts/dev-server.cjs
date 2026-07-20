#!/usr/bin/env node
/**
 * Development entrypoint for the Notees frontend container.
 *
 * Starts Vite on an internal plain-HTTP port, then exposes both HTTPS and
 * HTTP via lightweight TLS-terminating TCP proxies using only Node built-ins.
 *
 * This avoids needing nginx while still providing:
 *   - https://localhost:5173  (self-signed TLS, secure context)
 *   - http://localhost:5172   (plain HTTP)
 *
 * Vite sees the original Host header because the proxies forward the raw
 * TCP stream after TLS termination.
 */

const net = require('net');
const tls = require('tls');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');

const CERT = '/tmp/notees-dev.crt';
const KEY = '/tmp/notees-dev.key';

const VITE_HOST = '127.0.0.1';
const VITE_PORT = 5174;
const HTTPS_PORT = 5173;
const HTTP_PORT = 5172;

const VITE_STARTUP_RETRIES = 30;
const VITE_STARTUP_DELAY_MS = 500;

function log(...args) {
  console.log('[dev-server]', ...args);
}

function ensureCert() {
  if (fs.existsSync(CERT) && fs.existsSync(KEY)) return;

  log('Generating self-signed certificate for HTTPS dev server...');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-nodes',
      '-days',
      '365',
      '-newkey',
      'rsa:2048',
      '-keyout',
      KEY,
      '-out',
      CERT,
      '-subj',
      '/CN=notees-dev',
      '-addext',
      'subjectAltName=DNS:localhost,DNS:atlas,DNS:atlas.ts.net,IP:127.0.0.1',
    ],
    { stdio: 'inherit' }
  );
}

function pipeSockets(a, b) {
  a.pipe(b);
  b.pipe(a);
  a.on('error', () => {});
  b.on('error', () => {});
  a.on('close', () => b.destroy());
  b.on('close', () => a.destroy());
}

function startProxyServers() {
  const certOptions = {
    key: fs.readFileSync(KEY),
    cert: fs.readFileSync(CERT),
  };

  const httpsServer = tls.createServer(certOptions, (clientSocket) => {
    const upstream = net.connect(VITE_PORT, VITE_HOST);
    pipeSockets(clientSocket, upstream);
  });

  const httpServer = net.createServer((clientSocket) => {
    const upstream = net.connect(VITE_PORT, VITE_HOST);
    pipeSockets(clientSocket, upstream);
  });

  httpsServer.listen(HTTPS_PORT, () => {
    log(`HTTPS proxy listening on https://0.0.0.0:${HTTPS_PORT}`);
  });

  httpServer.listen(HTTP_PORT, () => {
    log(`HTTP proxy listening on http://0.0.0.0:${HTTP_PORT}`);
  });

  httpsServer.on('error', (err) => {
    log('HTTPS server error:', err.message);
  });
  httpServer.on('error', (err) => {
    log('HTTP server error:', err.message);
  });
}

function waitForVite() {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    const tryConnect = () => {
      const sock = net.connect(VITE_PORT, VITE_HOST);

      sock.on('connect', () => {
        sock.destroy();
        resolve();
      });

      sock.on('error', () => {
        sock.destroy();
        attempt += 1;

        if (attempt >= VITE_STARTUP_RETRIES) {
          reject(
            new Error(
              `Vite did not become ready on ${VITE_HOST}:${VITE_PORT} after ${VITE_STARTUP_RETRIES} attempts`
            )
          );
          return;
        }

        setTimeout(tryConnect, VITE_STARTUP_DELAY_MS);
      });
    };

    tryConnect();
  });
}

async function main() {
  ensureCert();

  const vite = spawn('npm', ['run', 'dev', '--', '--host', '0.0.0.0', '--port', String(VITE_PORT)], {
    stdio: 'inherit',
    shell: false,
  });

  vite.on('exit', (code) => {
    process.exit(code ?? 0);
  });

  const forwardSignal = (signal) => {
    vite.kill(signal);
  };
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));
  process.on('SIGINT', () => forwardSignal('SIGINT'));

  try {
    await waitForVite();
  } catch (err) {
    log(err.message);
    vite.kill('SIGTERM');
    process.exit(1);
  }

  startProxyServers();
}

main().catch((err) => {
  log('Fatal error:', err.message);
  process.exit(1);
});
