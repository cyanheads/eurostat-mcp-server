/**
 * @fileoverview Tool registration gates. Boots the built server over HTTP under
 * each combination of the settings that gate the dataframe tools and checks the
 * two surfaces a gate controls: `tools/list`, which is what a client can call,
 * and the landing page, where a gated tool stays visible with the reason it is
 * off and the setting that turns it on.
 * @module tests/integration/tool-registration.int.test
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DIST_INDEX = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

/** A pre-2026 protocol revision; a stateless server answers it without `initialize`. */
const PROTOCOL_VERSION = '2025-11-25';

/** The startup record naming the port the server actually bound. */
const LISTENING = /HTTP transport listening at http:\/\/127\.0\.0\.1:(\d+)\//;

const CORE_TOOLS = [
  'eurostat_search_datasets',
  'eurostat_browse_themes',
  'eurostat_get_dataset_info',
  'eurostat_get_dimension_values',
  'eurostat_query_dataset',
  'eurostat_download_dataset',
];

interface RunningServer {
  port: number;
  stop: () => Promise<void>;
}

interface LandingCard {
  disabled: boolean;
  hint?: string;
  reason?: string;
}

let workDir: string;

/** Every server this suite spawned, so `afterAll` can stop one a timed-out test never reached. */
const children = new Set<ChildProcess>();

beforeAll(() => {
  if (!existsSync(DIST_INDEX)) {
    throw new Error(`Built server not found at ${DIST_INDEX}. Run "bun run rebuild" first.`);
  }
  workDir = mkdtempSync(join(tmpdir(), 'eurostat-tool-registration-'));
});

afterAll(async () => {
  await Promise.all([...children].map(stopProcess));
  rmSync(workDir, { recursive: true, force: true });
});

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

interface SpawnedServer {
  child: ChildProcess;
  /** The server's own log file. Under Vitest's `NODE_ENV=test` it is the only log sink. */
  log: () => string;
  /** Everything written to stdout and stderr, where a startup banner lands. */
  output: () => string;
}

/**
 * Spawns `dist/index.js` over HTTP with `gate` layered over the inherited
 * environment. Every gate variable is removed from what the child inherits first,
 * so the shell running the suite cannot decide a case.
 */
function spawnServer(gate: Record<string, string>): SpawnedServer {
  const {
    CANVAS_PROVIDER_TYPE: _canvas,
    EUROSTAT_DATAFRAME_DROP_ENABLED: _drop,
    // DEBUG would add a stack trace to a startup banner.
    DEBUG: _debug,
    ...inherited
  } = process.env;
  const logsDir = mkdtempSync(join(workDir, 'logs-'));
  const child = spawn(process.execPath, [DIST_INDEX], {
    // The framework loads `.env` from the working directory; an empty one keeps a local file out.
    cwd: workDir,
    env: {
      ...inherited,
      MCP_TRANSPORT_TYPE: 'http',
      MCP_HTTP_HOST: '127.0.0.1',
      // The OS picks a free port; the server logs the one it bound.
      MCP_HTTP_PORT: '0',
      MCP_LOG_LEVEL: 'info',
      LOGS_DIR: logsDir,
      CANVAS_TEMP_PATH: join(workDir, 'canvas'),
      // Nothing here should reach upstream; a stray call fails against a closed local port.
      EUROSTAT_BASE_URL: 'http://127.0.0.1:9',
      EUROSTAT_COMEXT_BASE_URL: 'http://127.0.0.1:9',
      ...gate,
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
  const logFile = join(logsDir, 'combined.log');
  return {
    child,
    log: () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''),
    output: () => output,
  };
}

/** Boots the server and resolves once it logs the port it is listening on. */
async function startServer(gate: Record<string, string>): Promise<RunningServer> {
  const { child, log, output } = spawnServer(gate);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const port = LISTENING.exec(log())?.[1];
    if (port !== undefined) return { port: Number(port), stop: () => stopProcess(child) };
    if (child.exitCode !== null) {
      throw new Error(`Server exited with code ${child.exitCode}: ${output().slice(-1500)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await stopProcess(child);
  throw new Error(`Server did not report a listening port: ${log().slice(-1500)}`);
}

/** Boots the server with `gate` and resolves with its exit code once it stops on its own. */
async function runToExit(
  gate: Record<string, string>,
): Promise<{ code: number | null; output: string }> {
  const { child, output } = spawnServer(gate);
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server kept running: ${output()}`)), 15_000);
    child.once('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  }).finally(() => stopProcess(child));
  return { code, output: output() };
}

/** Boots the server, starts it with `gate`, runs `body`, and always stops it. */
async function withServer(
  gate: Record<string, string>,
  body: (port: number) => Promise<void>,
): Promise<void> {
  const server = await startServer(gate);
  try {
    await body(server.port);
  } finally {
    await server.stop();
  }
}

interface JsonRpcMessage {
  error?: { code: number; message: string };
  result?: Record<string, unknown>;
}

/** Sends one JSON-RPC request to the MCP endpoint and returns its response message. */
async function rpc(
  port: number,
  method: string,
  params: Record<string, unknown>,
): Promise<JsonRpcMessage> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await response.text();
  const payload = response.headers.get('content-type')?.includes('text/event-stream')
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .find((data) => data.length > 0)
    : text;
  if (payload === undefined) throw new Error(`No JSON-RPC message in response: ${text}`);
  return JSON.parse(payload) as JsonRpcMessage;
}

/** Names `tools/list` serves — the tools a client can call. */
async function listedTools(port: number): Promise<string[]> {
  const message = await rpc(port, 'tools/list', {});
  const tools = message.result?.tools as { name: string }[] | undefined;
  if (!tools) throw new Error(`tools/list returned no tools: ${JSON.stringify(message)}`);
  return tools.map((t) => t.name);
}

/** Undoes the escaping the landing page's HTML template applies to text. */
function decodeHtml(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

/**
 * The landing-page card for `name`: whether it renders as disabled, and the
 * reason and hint a disabled card carries. `undefined` when the page has no card
 * for the tool at all.
 */
async function landingCard(port: number, name: string): Promise<LandingCard | undefined> {
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  const start = html.indexOf(`id="tool-${name}"`);
  if (start === -1) return;
  const card = html.slice(start, html.indexOf('</article>', start));
  const reason = /<p class="disabled-reason"><strong>Disabled\.<\/strong> ([^<]*)<\/p>/.exec(
    card,
  )?.[1];
  const hint = /<pre class="disabled-hint"><code>([^<]*)<\/code><\/pre>/.exec(card)?.[1];
  return {
    disabled: card.includes('data-mutability="disabled"'),
    ...(reason !== undefined && { reason: decodeHtml(reason) }),
    ...(hint !== undefined && { hint: decodeHtml(hint) }),
  };
}

const CANVAS_OFF_REASON =
  'This deployment runs without a dataframe canvas, so there are no tables to address.';

/** Calls the drop tool with a well-formed canvas id no canvas carries. */
const callDrop = (port: number) =>
  rpc(port, 'tools/call', {
    name: 'eurostat_dataframe_drop',
    arguments: { canvas_id: 'zzzzzzzzzz', table_name: 'df_abcd1234' },
  });

/** Asserts the drop tool is uncallable: the server answers that no such tool is registered. */
async function expectDropUncallable(port: number): Promise<void> {
  const message = await callDrop(port);
  expect(message.result).toBeUndefined();
  expect(message.error?.message).toContain('eurostat_dataframe_drop not found');
}

describe('dataframe tool registration', () => {
  it('keeps every dataframe tool off tools/list without a canvas, naming each setting still missing', async () => {
    await withServer({}, async (port) => {
      expect(await listedTools(port)).toEqual(CORE_TOOLS);

      for (const name of ['eurostat_dataframe_describe', 'eurostat_dataframe_query']) {
        expect(await landingCard(port, name)).toEqual({
          disabled: true,
          reason: CANVAS_OFF_REASON,
          hint: 'CANVAS_PROVIDER_TYPE=duckdb',
        });
      }
      // Turning the canvas on alone would still leave the drop tool off, so its hint names both.
      expect(await landingCard(port, 'eurostat_dataframe_drop')).toEqual({
        disabled: true,
        reason: CANVAS_OFF_REASON,
        hint: 'CANVAS_PROVIDER_TYPE=duckdb\nEUROSTAT_DATAFRAME_DROP_ENABLED=true',
      });
      await expectDropUncallable(port);
    });
  });

  it('names only the canvas for the drop tool when its own flag is already on', async () => {
    await withServer({ EUROSTAT_DATAFRAME_DROP_ENABLED: 'true' }, async (port) => {
      expect(await listedTools(port)).toEqual(CORE_TOOLS);
      expect(await landingCard(port, 'eurostat_dataframe_drop')).toEqual({
        disabled: true,
        reason: CANVAS_OFF_REASON,
        hint: 'CANVAS_PROVIDER_TYPE=duckdb',
      });
      await expectDropUncallable(port);
    });
  });

  for (const flag of [undefined, 'false']) {
    it(`lists describe and query but not drop when the canvas is on and the drop flag is ${flag ?? 'unset'}`, async () => {
      const gate: Record<string, string> = { CANVAS_PROVIDER_TYPE: 'duckdb' };
      if (flag !== undefined) gate.EUROSTAT_DATAFRAME_DROP_ENABLED = flag;

      await withServer(gate, async (port) => {
        expect(await listedTools(port)).toEqual([
          ...CORE_TOOLS,
          'eurostat_dataframe_describe',
          'eurostat_dataframe_query',
        ]);
        expect(await landingCard(port, 'eurostat_dataframe_describe')).toEqual({ disabled: false });
        expect(await landingCard(port, 'eurostat_dataframe_query')).toEqual({ disabled: false });
        expect(await landingCard(port, 'eurostat_dataframe_drop')).toEqual({
          disabled: true,
          reason:
            'Table cleanup is disabled in this deployment, so a staged table leaves only when its canvas expires.',
          hint: 'EUROSTAT_DATAFRAME_DROP_ENABLED=true',
        });
        await expectDropUncallable(port);
      });
    });
  }

  it('registers the live drop tool when the canvas and the drop flag are both on', async () => {
    await withServer(
      { CANVAS_PROVIDER_TYPE: 'duckdb', EUROSTAT_DATAFRAME_DROP_ENABLED: 'true' },
      async (port) => {
        expect(await listedTools(port)).toEqual([
          ...CORE_TOOLS,
          'eurostat_dataframe_describe',
          'eurostat_dataframe_query',
          'eurostat_dataframe_drop',
        ]);
        expect(await landingCard(port, 'eurostat_dataframe_drop')).toEqual({ disabled: false });

        // The handler runs: an unknown canvas comes back as its typed failure, not "tool not found".
        const message = await callDrop(port);
        expect(message.error).toBeUndefined();
        expect(message.result).toMatchObject({
          isError: true,
          structuredContent: {
            error: {
              code: JsonRpcErrorCode.NotFound,
              data: { reason: 'canvas_not_found', recovery: { hint: expect.any(String) } },
            },
          },
        });
      },
    );
  });

  it('fails startup with the configuration banner when the drop flag does not parse', async () => {
    const { code, output } = await runToExit({
      CANVAS_PROVIDER_TYPE: 'duckdb',
      EUROSTAT_DATAFRAME_DROP_ENABLED: 'maybe',
    });
    expect(code).toBe(1);
    expect(output).toContain('Configuration error — server failed to start');
    expect(output).toContain('EUROSTAT_DATAFRAME_DROP_ENABLED');
    // A clean banner, not an uncaught error's stack trace.
    expect(output).not.toMatch(/^\s+at /m);
  });
});
