/**
 * @fileoverview HTTP session-mode default. Boots the built server and checks the
 * session posture a 2025-era `initialize` receives: stateless — the default
 * `createApp()` declares — when `MCP_SESSION_MODE` is unset, and a stateful
 * session when an operator sets `MCP_SESSION_MODE=stateful`, which overrides it.
 * @module tests/integration/session-mode.int.test
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DIST_INDEX = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

/** A pre-2026 protocol revision, which negotiates sessions over `Mcp-Session-Id`. */
const PROTOCOL_VERSION = '2025-11-25';

interface RunningServer {
  port: number;
  stop: () => Promise<void>;
}

let logsDir: string;

/** Every server this suite spawned, so `afterAll` can stop one a timed-out test never reached. */
const children = new Set<ChildProcess>();

beforeAll(() => {
  if (!existsSync(DIST_INDEX)) {
    throw new Error(`Built server not found at ${DIST_INDEX}. Run "bun run rebuild" first.`);
  }
  logsDir = mkdtempSync(join(tmpdir(), 'eurostat-session-mode-'));
});

afterAll(async () => {
  await Promise.all([...children].map(stopProcess));
  rmSync(logsDir, { recursive: true, force: true });
});

/** Finds a free port by binding port 0 and releasing it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      probe.close(() =>
        port === undefined ? reject(new Error('No port assigned')) : resolve(port),
      );
    });
  });
}

/** Stops the one child process this suite started, escalating to SIGKILL after 3 s. */
function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

/**
 * Boots `dist/index.js` over HTTP and waits for `/healthz`. `MCP_SESSION_MODE` is
 * removed from the inherited environment and set only when `sessionMode` is given.
 */
async function startServer(sessionMode?: string): Promise<RunningServer> {
  const port = await freePort();
  const { MCP_SESSION_MODE: _inherited, ...inherited } = process.env;
  const child = spawn(process.execPath, [DIST_INDEX], {
    // The framework loads `.env` from the working directory; an empty one keeps a local file out.
    cwd: logsDir,
    env: {
      ...inherited,
      MCP_TRANSPORT_TYPE: 'http',
      MCP_HTTP_HOST: '127.0.0.1',
      MCP_HTTP_PORT: String(port),
      // A port taken since freePort() fails the boot instead of moving the server to port+1.
      MCP_HTTP_MAX_PORT_RETRIES: '0',
      MCP_LOG_LEVEL: 'error',
      LOGS_DIR: logsDir,
      // Nothing here should reach upstream; a stray call fails against a closed local port.
      EUROSTAT_BASE_URL: 'http://127.0.0.1:9',
      ...(sessionMode !== undefined && { MCP_SESSION_MODE: sessionMode }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);

  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited with code ${child.exitCode}: ${output.slice(-500)}`);
    }
    const healthy = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(1_000),
    })
      .then((res) => res.ok)
      .catch(() => false);
    if (healthy) return { port, stop: () => stopProcess(child) };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await stopProcess(child);
  throw new Error(`Server did not become healthy on port ${port}: ${output.slice(-500)}`);
}

/** Sends a 2025-era `initialize` and returns the response with its JSON-RPC message. */
async function initialize(port: number): Promise<{ message: JsonRpcMessage; response: Response }> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'session-mode-test', version: '1.0.0' },
      },
    }),
  });
  const text = await response.text();
  /**
   * A stateful SSE response can open with a priming event whose `data:` is empty
   * (the resumability cursor), so the message is the first non-empty data line.
   */
  const payload = response.headers.get('content-type')?.includes('text/event-stream')
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .find((data) => data.length > 0)
    : text;
  if (payload === undefined) throw new Error(`No JSON-RPC message in response: ${text}`);
  return { message: JSON.parse(payload) as JsonRpcMessage, response };
}

interface JsonRpcMessage {
  error?: unknown;
  result?: { protocolVersion?: string; serverInfo?: { name?: string } };
}

describe('HTTP session mode', () => {
  it('serves a 2025-era initialize without a session when MCP_SESSION_MODE is unset', async () => {
    const server = await startServer();
    try {
      const { message, response } = await initialize(server.port);
      expect(response.status).toBe(200);
      expect(message.error).toBeUndefined();
      expect(message.result?.serverInfo?.name).toBe('eurostat-mcp-server');
      expect(response.headers.get('mcp-session-id')).toBeNull();
    } finally {
      await server.stop();
    }
  });

  it('opens a session when MCP_SESSION_MODE=stateful overrides the declared default', async () => {
    const server = await startServer('stateful');
    try {
      const { message, response } = await initialize(server.port);
      expect(response.status).toBe(200);
      expect(message.error).toBeUndefined();
      expect(message.result?.serverInfo?.name).toBe('eurostat-mcp-server');
      expect(response.headers.get('mcp-session-id')).toBeTruthy();
    } finally {
      await server.stop();
    }
  });
});
