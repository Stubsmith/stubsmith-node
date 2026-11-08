/**
 * The SDK's own traffic (captures, rules sync, bundle and fixture fetches)
 * goes over https only. Plain http is accepted for a backend on this machine
 * (`localhost`, `127.0.0.1`, `::1`) so local development keeps working.
 * Port of stubsmith/_endpoint.py.
 */

const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Thrown for a Stubsmith URL the SDK will not send to. */
export class InsecureEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsecureEndpointError";
  }
}

/**
 * Throw {@link InsecureEndpointError} unless `url` is https or local http.
 * The message names only the scheme and host, so credentials in the URL are
 * never echoed into logs.
 */
export function checkEndpoint(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new InsecureEndpointError(
      "stubsmith: the Stubsmith URL is not a valid URL; the SDK sends only to an https URL.",
    );
  }
  if (u.protocol === "https:" && u.hostname !== "") return;
  if (u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname)) return;
  const shown = u.hostname ? `${u.protocol}//${u.hostname}` : u.protocol;
  throw new InsecureEndpointError(
    `stubsmith: refusing to send to ${shown}. The SDK sends only over https; ` +
      "plain http is allowed only for localhost, 127.0.0.1 and ::1.",
  );
}
