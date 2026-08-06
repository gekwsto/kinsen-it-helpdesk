/**
 * Bounded exponential-backoff retry wrapper for Microsoft Graph HTTP calls —
 * used by the organization-sync services (lib/services/organization-*.ts),
 * which make many more Graph requests per run (full tenant scan + per-user
 * manager/directReports traversal) than the existing mailbox/directory-value
 * code, making 429 throttling a real, expected occurrence rather than an
 * edge case. Deliberately NOT retrofitted onto lib/microsoft-graph.ts or
 * lib/services/microsoft-directory-service.ts — those are out of scope,
 * already working, and their own (documented, accepted) lack of retry logic
 * is a separate, pre-existing low-severity finding.
 *
 * Only retries responses that are genuinely worth retrying: 429 (rate
 * limited — honors the `Retry-After` header when Graph sends one) and
 * 502/503/504 (transient upstream/gateway failures). Never retries 401/403
 * (a permission/auth problem retrying won't fix) or any other 4xx. Never
 * retries a thrown network exception (DNS failure, TLS error, timeout) —
 * those propagate immediately to the caller, which already has its own
 * typed `network_error` handling (see organization-directory-sync-service.ts).
 */

export interface GraphRetryOptions {
  /** Total attempts including the first — default 5. */
  maxAttempts?: number;
  /** Base delay for exponential backoff, before jitter — default 500ms. */
  baseDelayMs?: number;
  /** Upper bound on any single computed delay — default 10000ms. */
  maxDelayMs?: number;
}

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

const DEFAULT_OPTIONS: Required<GraphRetryOptions> = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 10000,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parses a `Retry-After` header value, which Graph sends as either an
 * integer number of seconds or (rarely, for other Microsoft services, not
 * Graph itself, but handled defensively) an HTTP-date. Returns milliseconds,
 * or null if the header is absent/unparseable — callers fall back to
 * exponential backoff in that case.
 */
function parseRetryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds * 1000;
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) {
    const delta = asDate - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

function computeBackoffDelayMs(attempt: number, opts: Required<GraphRetryOptions>): number {
  // attempt is 1-indexed (1 = first retry). Exponential: base * 2^(attempt-1),
  // plus up to 25% random jitter so many concurrent callers retrying after
  // the same 429 don't all hammer Graph again in lockstep.
  const exponential = opts.baseDelayMs * Math.pow(2, attempt - 1);
  const capped = Math.min(exponential, opts.maxDelayMs);
  const jitter = capped * 0.25 * Math.random();
  return Math.round(capped + jitter);
}

/**
 * Performs `fetch(url, init)`, retrying with backoff on 429/502/503/504 up
 * to `maxAttempts` total tries. Always resolves to a `Response` — including
 * the final, still-failing one after retries are exhausted — never throws
 * for an HTTP error status (matches this codebase's existing "typed result,
 * never throw for an expected Graph failure" convention). A thrown network
 * exception from `fetch` itself propagates to the caller unretried.
 */
export async function fetchWithGraphRetry(
  url: string,
  init: RequestInit,
  options?: GraphRetryOptions
): Promise<Response> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastResponse: Response | null = null;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    const response = await fetch(url, init);
    if (!RETRYABLE_STATUSES.has(response.status) || attempt === opts.maxAttempts) {
      return response;
    }
    lastResponse = response;
    const retryAfterMs = parseRetryAfterMs(response);
    const delayMs = retryAfterMs ?? computeBackoffDelayMs(attempt, opts);
    await sleep(Math.min(delayMs, opts.maxDelayMs));
  }

  // Unreachable in practice (the loop always returns on its last iteration),
  // but keeps the function's return type honest without a non-null assertion.
  return lastResponse as Response;
}
