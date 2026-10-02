// Never persist upstream error bodies or exception messages: they can contain
// account data or credentials. Store only bounded, actionable classifications.
export function classifyCollectorError(error: unknown): {
  errorKind: string;
  appleHttpStatus: number | null;
} {
  if (error instanceof Error && error.name === "AppleMusicApiError") {
    const status = (error as Error & { status?: unknown }).status;
    return {
      errorKind: "apple_api_error",
      appleHttpStatus: typeof status === "number" && Number.isInteger(status) ? status : null
    };
  }
  if (error instanceof Error) {
    if (error.message.startsWith("Apple Music API credentials are not configured")) {
      return { errorKind: "apple_credentials_missing", appleHttpStatus: null };
    }
    if (error.message.startsWith("Apple Music is not connected")) {
      return { errorKind: "apple_not_connected", appleHttpStatus: null };
    }
    if (error.name === "TimeoutError" || error.name === "AbortError" || error.message.startsWith("Apple Music API request timed out")) {
      return { errorKind: "apple_timeout", appleHttpStatus: null };
    }
  }
  return { errorKind: "storage_or_internal_error", appleHttpStatus: null };
}
