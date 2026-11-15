// lib/upstream.ts — one call to the grader's gateway, and how a refusal reads.
//
// Every free model is reached the same way: POST <gateway>/chat/completions
// with the dialled id (`openrouter/<vendor>/<model>:free`) in a Chat
// Completions body. The sandbox key in OPENAI_API_KEY is a dummy the gateway
// swaps for the entrant's own pushed OpenRouter key, so this file sends it
// exactly as an OpenAI client would — `Authorization: Bearer <key>` — and
// never looks for a key anywhere else. A call that reaches the gateway is a
// real completion; a refusal is the provider's own 429 or 5xx (or the
// gateway's 400/401) handed back as it was sent.
//
// One call is capped at 30 s, the env's per-answer wait: a hung call must end
// by itself, because a trial still running at its 240 s wall scores 0. The
// caller owns the response — on success it relays the body (JSON or SSE) to
// the client, on a refusal it reads the error text for the trail and tries
// the next model. A network error or the 30 s cap throws instead of
// returning a response, and the caller counts that as a refusal with no body.
//
// The trail is how a recovered refusal reaches the scorer: the response
// header `x-makefun-upstream-failures` carries at most 8 rows, in the order
// the calls were refused, each `{"status": <number>, "code": "<string>",
// "model": "<id or null>"}`. A header over 8 KiB is read as no trail at all,
// so the value is kept short.

/** Longest one gateway call may run, in milliseconds. */
export const CALL_LIMIT_MS = 30_000;
/** Most rows the failure trail may carry. */
export const TRAIL_LIMIT = 8;
/** Longest the trail header's JSON may be, in bytes. */
export const TRAIL_MAX_BYTES = 8192;

/** One refused gateway call, as the trail header spells it. */
export interface Refusal {
  status: number;
  code: string;
  model: string | null;
}

/**
 * The gateway's Chat Completions URL from its base. A base already ending
 * in `/v1` is used as it stands; any other spelling gets `/v1` appended, so
 * both reach the same route. An empty base gives an empty URL.
 */
export function completionsEndpoint(base: string): string {
  const clean = base.replace(/\/+$/, '');
  if (clean === '') return '';
  return clean.endsWith('/v1') ? `${clean}/chat/completions` : `${clean}/v1/chat/completions`;
}

/**
 * Dial one model on the gateway. Throws on a network error or when the
 * 30 s cap fires; the caller treats that as a refusal of this model.
 */
export async function callUpstream(
  base: string,
  key: string,
  modelId: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${key}`,
  };
  if (payload.stream === true) headers.accept = 'text/event-stream';
  return fetch(completionsEndpoint(base), {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...payload, model: modelId }),
    signal: AbortSignal.timeout(CALL_LIMIT_MS),
  });
}

/** A short string from a value, or null when it is not a non-empty string. */
function shortString(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  return value.slice(0, 64);
}

/** The code inside an error payload: its `error.code`, else `error.type`, else a top-level `code`. */
function codeFromPayload(payload: Record<string, unknown>): string | null {
  const inner = payload.error;
  if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
    const err = inner as Record<string, unknown>;
    const byCode = err.code;
    if (typeof byCode === 'string') {
      const text = shortString(byCode);
      if (text !== null) return text;
    } else if (typeof byCode === 'number' && Number.isFinite(byCode)) {
      return String(byCode);
    }
    const byType = shortString(err.type);
    if (byType !== null) return byType;
  }
  return shortString(payload.code);
}

/** The code for a refusal: the provider's own code when its body names one, else `http_<status>`. */
export function refusalCode(status: number, bodyText: string): string {
  if (bodyText !== '') {
    try {
      const parsed: unknown = JSON.parse(bodyText);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const code = codeFromPayload(parsed as Record<string, unknown>);
        if (code !== null) return code;
      }
    } catch {
      // Not JSON: the status is the code.
    }
  }
  return `http_${status}`;
}

/** One refused call as a trail row. */
export function refusalRecord(status: number, bodyText: string, modelId: string | null): Refusal {
  return { status, code: refusalCode(status, bodyText), model: modelId };
}

/** The trail header's value, or null when there is nothing to report. */
export function trailValue(refusals: readonly Refusal[]): string | null {
  if (refusals.length === 0) return null;
  const text = JSON.stringify(refusals.slice(0, TRAIL_LIMIT));
  if (text.length <= TRAIL_MAX_BYTES) return text;
  return JSON.stringify(refusals.slice(0, 4));
}
