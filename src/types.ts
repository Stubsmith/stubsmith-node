/** Shared public types for the capture runtime. */

/** Header name to value; repeated headers are joined with `, ` as Node does. */
export type HeaderRecord = Record<string, string>;

/** Where a capture came from; the wire `source` field. */
export type CaptureSource = "node-http" | "node-fetch";

/** One finished request/response pair handed to {@link StubsmithClient.capture}. */
export interface CapturedExchange {
  method: string;
  /** Full outbound URL including scheme, host, path and query (the ORIGINAL url for redirects). */
  url: string;
  reqHeaders: HeaderRecord;
  reqBody: string;
  status: number;
  respHeaders: HeaderRecord;
  respBody: string;
  /** Milliseconds from sending the request to receiving the response headers. */
  durationMs: number;
  source: CaptureSource;
}

export interface StubsmithOptions {
  /** Defaults to `STUBSMITH_API_KEY`. An empty key disables the SDK entirely. */
  apiKey?: string;
  /** Ingest endpoint; defaults to `STUBSMITH_URL`. */
  url?: string;
  /** Backend for rules sync; defaults to `STUBSMITH_BACKEND_URL`. */
  backendUrl?: string;
  /** Ingest POST timeout in ms. Default 5000. */
  timeoutMs?: number;
  /** Fraction of captures sent, 0 to 1. Default 1. */
  sampleRate?: number;
  /** Rules poll interval in ms. Default 60000. */
  rulesPollInterval?: number;
  /** Gzip payloads of 1024 bytes or more. Default true. */
  compress?: boolean;
  /** Debug logging to stderr; defaults to `STUBSMITH_DEBUG`. */
  debug?: boolean;
  /**
   * Placeholder salt; defaults to `STUBSMITH_MASK_SALT`. A value given here is
   * passed to the privacy pipeline directly; the environment is not modified.
   */
  maskSalt?: string;
  /** Advanced: override the queue and payload ceilings (defaults 1000 items, 32 MiB, 10 MiB). */
  limits?: {
    maxQueueItems?: number;
    maxQueueBytes?: number;
    maxPayloadBytes?: number;
  };
}

export interface FlushOptions {
  /** Default 5000. */
  timeoutMs?: number;
}
