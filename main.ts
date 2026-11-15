// free-model-aggregator-02 v02 — budget-spreading: one server, two wires,
// a real free model behind every answer.
//
// The entry reads the brief, builds the one catalog (exactly the fourteen
// free OpenRouter models), registers with the env, and answers the trial's
// six prompts. For each prompt it ranks the free models that meet the
// requirements by rating less a spread discount — 60 milli per attempt
// already spent on that model, capped at 180, plus 25 after two refusals
// in a row — so traffic rotates to fresh models instead of hammering the
// top-rated one until it rate-limits. It dials the best through the
// grader's gateway on Chat Completions and fails over down the ranking when
// a call is refused (429, 402 or 5xx). A refusal is never an answer: the
// loop stops at the first success, and the refusals it recovered from are
// reported on the response in `x-makefun-upstream-failures`, the only way
// the failover column can see them.
//
// A request travels in the gateway's wire untouched: system prompt, user
// text (images included), tools, stop sequences, max_tokens, JSON mode.
// The gateway refuses a request with no output cap, so a body naming none
// gets a default of 1024. The `model` field on every answer and every
// streamed chunk is the id this entry really dialled: the house records
// every gateway call, and a claim with no matching successful call earns
// the prompt nothing. The answer comes back in the wire the client used,
// with the provider's text whole, its usage counts as that wire reports
// them, and its stop reason mapped.
//
// `node main.ts --list` prints the catalog as one JSON document and exits 0.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildCatalog,
  freeModels,
  isRecord,
  readBrief,
  type CatalogReport,
  type Json,
  type Requirement,
} from './lib/providers.ts';
import {
  anthropicError,
  anthropicEventsFromOpenAI,
  anthropicModelList,
  anthropicToOpenAI,
  openAIError,
  openAIJsonWithModel,
  openAIModelList,
  openAIStreamWithModel,
  openAIToAnthropic,
  type ServedModel,
} from './lib/wire.ts';
import { callUpstream, refusalRecord, trailValue, type Refusal } from './lib/upstream.ts';
import { SpreadRouter } from './lib/route.ts';

/** Protocol version carried in the register body. */
const PROTOCOL = 1;
/** Milliseconds between GET /work polls. */
const POLL_EVERY_MS = 100;
/** Largest client request body read, in bytes. */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
/** Output cap given to a body naming none: the gateway refuses a capless request. */
const DEFAULT_OUTPUT_TOKENS = 1024;
/** Port the env owns on one layout; the OS's ephemeral range never holds it. */
const ENV_PORT = 8080;

const envBase = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const briefFile = process.env.MAKEFUN_PROMPT_FILE ?? '';
const gatewayBase = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
/** The trial's dummy key for the gateway lane; the gateway swaps it for the entrant's own key. */
const gatewayKey = process.env.OPENAI_API_KEY ?? '';

const brief = readBrief(briefFile);
const catalogDoc: CatalogReport = buildCatalog(brief);
/** The router over the brief's free models. */
const spread = new SpreadRouter(freeModels(brief));
/** Which brief prompt row the next arriving request is: the client sends them in brief order. */
let nextPrompt = 0;

function logLine(line: string): void {
  process.stderr.write(`aggregator: ${line}\n`);
}

/** The brief's free models, as GET /v1/models lists them. */
function modelsForListing(): ServedModel[] {
  return freeModels(brief).map((row) => ({ id: row.id, provider: row.provider, display_name: row.display_name }));
}

/** A Chat Completions body guaranteed to name an output cap. */
function withCap(body: Json): Json {
  const capped =
    (typeof body.max_tokens === 'number' && Number.isFinite(body.max_tokens)) ||
    (typeof body.max_completion_tokens === 'number' && Number.isFinite(body.max_completion_tokens));
  return capped ? body : { ...body, max_tokens: DEFAULT_OUTPUT_TOKENS };
}

/** Requirements read off a request body, for a brief with no row for it. */
function requirementsFromRequest(body: Json): Requirement {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let imageSeen = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (isRecord(part) && (part.type === 'image' || part.type === 'image_url')) imageSeen = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return {
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    vision: imageSeen,
    json: format === 'json_object' || format === 'json_schema',
  };
}

/** The requirements of the request now arriving: the brief's row by arrival order, else the body's own. */
function requirementsOf(body: Json): Requirement {
  const row = brief.prompts[nextPrompt];
  nextPrompt += 1;
  if (row !== undefined) return row.requires;
  // The brief's prompt list is the declared source of each request's requirements; this fallback is
  // a guess for a brief that holds none.
  return requirementsFromRequest(body);
}

/** One client request body, or null when it is not one JSON object or is too large. */
async function readRequestBody(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buf.length;
    if (bytes > MAX_REQUEST_BYTES) return null;
    chunks.push(buf);
  }
  if (chunks.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...extraHeaders });
  res.end(text);
}

function sendFailure(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, kind: string, detail: string): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(kind, detail));
  else sendJson(res, status, openAIError(detail, kind, null));
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function serveModelList(req: IncomingMessage, res: ServerResponse): void {
  const list = modelsForListing();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
  else sendJson(res, 200, openAIModelList(list));
}

/** One served prompt: the model that really answered, the refusals it cost, and its gateway reply. */
interface Answered {
  modelId: string;
  refusals: Refusal[];
  upstream: Response;
}

/**
 * Serve one client request: walk the spread-ranked candidates until one
 * answers. A refusal goes on the trail and the next candidate is tried;
 * the first success is the answer and no further model is called. A
 * network error or the 30 s cap counts as a refusal of that model too.
 * A 401 is the trial's key, not the model — every model would refuse the
 * same way, so stop instead of spending the trial's 60-call budget on
 * calls that cannot succeed.
 */
async function serveWithFailover(wire: 'openai' | 'anthropic', body: Json): Promise<Answered | null> {
  const needs = requirementsOf(body);
  const ordered = spread.orderFor(needs);
  const refusals: Refusal[] = [];
  for (const pick of ordered) {
    const upstreamBody =
      wire === 'anthropic' ? withCap(anthropicToOpenAI(body, pick.id)) : withCap({ ...body, model: pick.id });
    let upstream: Response;
    try {
      upstream = await callUpstream(gatewayBase, gatewayKey, pick.id, upstreamBody);
    } catch (err) {
      const timedOut = (err as Error).name === 'TimeoutError';
      spread.record(pick.id, false);
      refusals.push({ status: timedOut ? 504 : 502, code: timedOut ? 'timeout' : 'upstream_unreachable', model: pick.id });
      logLine(`failover: ${pick.id} ${timedOut ? 'timed out' : 'unreachable'} (${(err as Error).message})`);
      continue;
    }
    if (!upstream.ok || upstream.body === null) {
      const text = await upstream.text();
      spread.record(pick.id, false);
      refusals.push(refusalRecord(upstream.status, text, pick.id));
      logLine(`failover: ${pick.id} refused HTTP ${upstream.status} (${refusals[refusals.length - 1].code})`);
      if (upstream.status === 401) break;
      continue;
    }
    spread.record(pick.id, true);
    return { modelId: pick.id, refusals, upstream };
  }
  return null;
}

/** The failure trail as response headers: the only way the failover column sees a recovered refusal. */
function trailHeaders(refusals: readonly Refusal[]): Record<string, string> {
  const value = trailValue(refusals);
  return value === null ? {} : { 'x-makefun-upstream-failures': value };
}

/** One prompt on either wire: JSON answer or streamed answer, both naming the model that served it. */
async function servePrompt(wire: 'openai' | 'anthropic', req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readRequestBody(req);
  if (body === null) {
    sendFailure(res, wire, 400, 'invalid_request_error', 'the request body is not one JSON object');
    return;
  }
  const answered = await serveWithFailover(wire, body);
  if (answered === null) {
    sendFailure(res, wire, 502, wire === 'anthropic' ? 'api_error' : 'upstream_error', 'no free model could serve this request');
    return;
  }
  const headers = trailHeaders(answered.refusals);
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...headers });
    try {
      if (wire === 'anthropic') {
        for await (const event of anthropicEventsFromOpenAI(answered.upstream.body as ReadableStream<Uint8Array>, answered.modelId)) res.write(event);
      } else {
        for await (const frame of openAIStreamWithModel(answered.upstream.body as ReadableStream<Uint8Array>, answered.modelId)) res.write(frame);
      }
    } finally {
      res.end();
    }
    return;
  }
  let payload: unknown;
  try {
    payload = await answered.upstream.json();
  } catch {
    sendFailure(res, wire, 502, wire === 'anthropic' ? 'api_error' : 'upstream_error', 'the gateway answered with a body that is not JSON');
    return;
  }
  const shaped =
    wire === 'anthropic'
      ? openAIToAnthropic(isRecord(payload) ? payload : {}, answered.modelId)
      : openAIJsonWithModel(isRecord(payload) ? payload : {}, answered.modelId);
  sendJson(res, 200, shaped, headers);
}

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    serveModelList(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await servePrompt('openai', req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await servePrompt('anthropic', req, res);
    return;
  }
  sendFailure(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

function startListening(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

/** POST /register with the port and the one catalog; the env answers with the trial's prompt count. */
async function registerWithEnv(port: number, report: CatalogReport): Promise<void> {
  const res = await fetch(`${envBase}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTOCOL, port, catalog: report }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`POST ${envBase}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const reply: unknown = await res.json();
  if (isRecord(reply) && typeof reply.requests === 'number') logLine(`registered: the trial holds ${reply.requests} prompts`);
}

/** Poll GET /work every 100 ms; exit 0 the moment it says done. */
function pollUntilDone(server: Server): void {
  let fetching = false;
  const timer = setInterval(() => {
    if (fetching) return;
    fetching = true;
    void (async () => {
      try {
        const res = await fetch(`${envBase}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        fetching = false;
      }
    })();
  }, POLL_EVERY_MS);
}

async function run(): Promise<void> {
  if (brief.error !== null) logLine(brief.error);
  if (process.argv.includes('--list')) {
    // The same document the register body carries, byte for byte: print the one built object and stop
    // before any server starts. A process whose stdout is not flushed loses the tail, so wait for it.
    const text = `${JSON.stringify(catalogDoc)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (envBase === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (gatewayBase === '') throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void dispatch(req, res).catch((err: unknown) => {
      logLine((err as Error).stack ?? String(err));
      if (!res.headersSent) sendFailure(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
    });
  });
  await startListening(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  if (port === ENV_PORT) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  logLine(`listening on 0.0.0.0:${port} with ${modelsForListing().length} free models`);
  await registerWithEnv(port, catalogDoc);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  pollUntilDone(server);
}

try {
  await run();
} catch (err) {
  logLine((err as Error).stack ?? String(err));
  process.exit(1);
}
