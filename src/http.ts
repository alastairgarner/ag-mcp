import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Brain } from './brain.js';
import { createServer } from './server.js';
import { errorMessage } from './errors.js';
import type { TokenAuth } from './auth.js';
import { limitsSchema } from './limits.js';
import type { ResourceLimits } from './limits.js';
import { finished } from 'node:stream/promises';

export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

type HttpOptions = {
  brain: Brain;
  auth: TokenAuth;
  host: string;
  port: number;
  allowedHosts: string[];
  allowedOrigins: string[];
  limits?: Partial<ResourceLimits>;
};

export async function startHttp({ brain, auth, host, port, allowedHosts, allowedOrigins, limits: options = {} }: HttpOptions) {
  const limits = limitsSchema.parse(options);
  let admitted = 0;
  if (!auth) throw new Error('HTTP authentication is required');
  if (!allowedHosts.length) throw new Error('At least one allowed hostname is required');
  let accepting = true;
  const active = new Set<Promise<void>>();
  const send = (res: ServerResponse, status: number, message: string) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ message }));
  };
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!accepting) { send(res, 503, 'Shutting down'); return; }
    // Hostnames are port-agnostic, never inferred from untrusted proxy headers.
    let authority: URL;
    try { authority = new URL(`http://${req.headers.host ?? ''}`); }
    catch { send(res, 403, 'Invalid Host'); return; }
    if (authority.username || authority.password || authority.pathname !== '/' || authority.search || authority.hash || !allowedHosts.includes(authority.hostname)) {
      send(res, 403, 'Host not allowed'); return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.includes(origin)) {
      send(res, 403, 'Origin not allowed'); return;
    }
    if (req.url === '/health' && req.method === 'GET') { send(res, 200, 'ok'); return; }
    if (req.url !== '/mcp') { send(res, 404, 'Not found'); return; }
    const principal = auth.authenticate(req.headersDistinct.authorization);
    if (!principal) {
      res.setHeader('www-authenticate', 'Bearer realm="markdown-brain"');
      send(res, 401, 'Unauthorized'); return;
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      send(res, 405, 'Stateless MCP accepts POST only'); return;
    }
    if (admitted >= limits.maxHttpRequests) {
      res.setHeader('retry-after', '1');
      res.setHeader('connection', 'close');
      send(res, 503, 'Server busy; retry later'); return;
    }
    // One SDK server/transport per request prevents cross-client request-ID collisions.
    // All requests still share ONE Brain instance and its serialized write queue.
    console.error(JSON.stringify({ event: 'mcp_request_authenticated', client: principal.name }));
    const server = createServer(brain);
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
      maxRequestBodySize: MAX_REQUEST_BYTES,
    });
    admitted++;
    try {
      await server.connect(transport);
      res.setHeader('cache-control', 'no-store');
      await transport.handleRequest(req, res);
      // Hold the slot through backpressure, not just until the tool finishes.
      if (!res.writableFinished && !res.destroyed) await finished(res, { cleanup: true });
    } finally {
      try { await server.close(); }
      finally { admitted--; }
    }
  };
  const http = createHttpServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, (req, res) => {
    const task = handle(req, res).catch(error => {
      console.error(JSON.stringify({ event: 'http_request_failed', error: errorMessage(error) }));
      if (!res.headersSent) send(res, 500, 'Internal server error');
      else if (!res.writableEnded) res.end();
    }).finally(() => { active.delete(task); });
    active.add(task);
  });
  http.maxConnections = limits.maxHttpConnections;
  http.maxRequestsPerSocket = 100;
  http.setTimeout(30_000, socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, () => { http.off('error', reject); resolve(); });
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  let closing: Promise<void> | undefined;
  return {
    port: address.port,
    get activeRequests(): number { return admitted; },
    close(): Promise<void> {
      accepting = false;
      closing ??= (async () => {
        await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
        await Promise.all(active);
      })();
      return closing;
    },
  };
}
