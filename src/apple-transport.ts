const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_GET_ATTEMPTS = 3;

export class AppleMusicApiError extends Error {
  readonly status: number;
  readonly responseBody: string;
  readonly codes: string[];
  readonly retryAfterMs: number | undefined;

  constructor(status: number, responseBody: string, retryAfter?: string | null) {
    super(`Apple Music API ${status}: ${responseBody.slice(0, 500)}`);
    this.name = "AppleMusicApiError";
    this.status = status;
    this.responseBody = responseBody;
    this.codes = appleErrorCodes(responseBody);
    this.retryAfterMs = parseRetryAfterMs(retryAfter);
  }

  hasCode(code: string): boolean {
    return this.codes.includes(code);
  }
}

export function isEmptyPlaylistTracksError(error: unknown): boolean {
  return error instanceof AppleMusicApiError && error.status === 404 && error.hasCode("40403");
}

export async function fetchAppleMusicWithRetry(
  url: string,
  init: RequestInit,
  options: FetchRetryOptions = {}
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const maxAttempts = method === "GET" ? (options.maxAttempts ?? DEFAULT_GET_ATTEMPTS) : 1;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetcher(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs)
      });
      // Persist a shared cooldown for 429 instead of retrying immediately or
      // truncating a long server-requested wait to five seconds.
      if (response.status === 429 || (parseRetryAfterMs(response.headers.get('Retry-After')) ?? 0) > 5_000) return response;
      if (!isRetryableStatus(response.status) || attempt === maxAttempts) return response;
      await response.body?.cancel();
      await sleep(retryDelayMs(response.headers.get("Retry-After"), attempt));
    } catch (error) {
      if (attempt === maxAttempts) {
        if (isAbortError(error)) {
          throw new Error(`Apple Music API request timed out after ${timeoutMs}ms`, { cause: error });
        }
        throw error;
      }
      await sleep(retryDelayMs(undefined, attempt));
    }
  }

  throw new Error("Apple Music API request failed without a response");
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Concurrency must be a positive integer");
  }
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

type FetchRetryOptions = {
  maxAttempts?: number;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
};

function appleErrorCodes(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as { errors?: Array<{ code?: unknown }> };
    return (parsed.errors ?? []).map((error) => error.code).filter((code): code is string => typeof code === "string");
  } catch {
    return [];
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const ms = Number(text) * 1_000;
    return Number.isSafeInteger(ms) && Number.isSafeInteger(now + ms) && Number.isFinite(new Date(now + ms).getTime()) ? ms : undefined;
  }
  if (!/[A-Za-z]{3}/.test(text)) return undefined;
  const dateMs = Date.parse(text);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - now) : undefined;
}

function retryDelayMs(retryAfter: string | null | undefined, attempt: number): number {
  const requested = parseRetryAfterMs(retryAfter);
  if (requested !== undefined) return requested;
  return Math.min(250 * (2 ** (attempt - 1)), 2_000);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function defaultSleep(milliseconds: number): Promise<void> {
  return scheduler.wait(milliseconds);
}
