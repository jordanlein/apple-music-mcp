const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_GET_ATTEMPTS = 3;

export class AppleMusicApiError extends Error {
  readonly status: number;
  readonly responseBody: string;
  readonly codes: string[];

  constructor(status: number, responseBody: string) {
    super(`Apple Music API ${status}: ${responseBody.slice(0, 500)}`);
    this.name = "AppleMusicApiError";
    this.status = status;
    this.responseBody = responseBody;
    this.codes = appleErrorCodes(responseBody);
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
      if (!isRetryableStatus(response.status) || attempt === maxAttempts) return response;
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

function retryDelayMs(retryAfter: string | null | undefined, attempt: number): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 5_000);
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.max(0, Math.min(dateMs - Date.now(), 5_000));
  }
  return Math.min(250 * (2 ** (attempt - 1)), 2_000);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function defaultSleep(milliseconds: number): Promise<void> {
  return scheduler.wait(milliseconds);
}
