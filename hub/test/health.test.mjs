import { describe, it, expect } from 'vitest';
import { waitForHttp, tcpAlive } from '../health.mjs';
import http from 'node:http';
import net from 'node:net';

describe('health', () => {
  it('waitForHttp resolve quando o endpoint responde <500', async () => {
    const srv = http.createServer((_, res) => { res.statusCode = 200; res.end('ok'); }).listen(0);
    const port = srv.address().port;
    await expect(waitForHttp(`http://127.0.0.1:${port}/`, 2000)).resolves.toBe(true);
    srv.close();
  });
  it('waitForHttp rejeita se nunca responde', async () => {
    await expect(waitForHttp('http://127.0.0.1:1/', 800)).rejects.toThrow();
  });

  it('tcpAlive resolve true quando a porta aceita conexão', async () => {
    const srv = net.createServer((s) => s.end()).listen(0);
    const port = srv.address().port;
    await expect(tcpAlive('127.0.0.1', port, 1000)).resolves.toBe(true);
    srv.close();
  });
  it('tcpAlive resolve false (sem lançar) quando nada escuta na porta', async () => {
    const srv = net.createServer().listen(0);
    const port = srv.address().port;
    await new Promise((r) => srv.close(r)); // libera a porta antes do probe
    await expect(tcpAlive('127.0.0.1', port, 500)).resolves.toBe(false);
  });
});
