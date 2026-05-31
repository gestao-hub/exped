import { describe, it, expect } from 'vitest';
import { waitForHttp, waitForTcp } from '../health.mjs';
import http from 'node:http';

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
});
