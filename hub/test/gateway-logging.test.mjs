import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const gatewayEntry = new URL('../../scripts/local-stack/gateway.mjs', import.meta.url);
const children = new Set();
const servers = new Set();

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function reservePort() {
  const server = http.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

function waitFor(check, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('timeout no gateway de teste'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  children.clear();
  await Promise.all([...servers].map(closeServer));
  servers.clear();
});

describe('logs do gateway local', () => {
  it('nao registra cada request bem-sucedido por padrao', async () => {
    const storage = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    servers.add(storage);
    const storagePort = await listen(storage);
    const gatewayPort = await reservePort();
    let output = '';
    const child = spawn(process.execPath, [fileURLToPath(gatewayEntry)], {
      env: {
        ...process.env,
        GATEWAY_PORT: String(gatewayPort),
        STORAGE_PORT: String(storagePort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });

    await waitFor(() => output.includes('[gateway] escutando'));
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/storage/v1/object/teste`);
    expect(response.status).toBe(200);
    await response.text();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(output).not.toContain('GET /storage/v1/object/teste -> storage');
  });

  it('registra falha HTTP do servico de destino mesmo sem access log', async () => {
    const storage = http.createServer((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"error":"indisponivel"}');
    });
    servers.add(storage);
    const storagePort = await listen(storage);
    const gatewayPort = await reservePort();
    let output = '';
    const child = spawn(process.execPath, [fileURLToPath(gatewayEntry)], {
      env: {
        ...process.env,
        GATEWAY_PORT: String(gatewayPort),
        STORAGE_PORT: String(storagePort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });

    await waitFor(() => output.includes('[gateway] escutando'));
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/storage/v1/object/falha`);
    expect(response.status).toBe(503);
    await response.text();
    await waitFor(() => output.includes('503'));

    expect(output).toContain('GET /storage/v1/object/falha -> storage');
    expect(output).toContain('503');
  });
});
