/**
 * Python `urllib.parse.urlparse` (3.14 semantics) for the pieces the privacy
 * pipeline reads: `netloc`, `path` (WITHOUT `;params`) and `query`. The
 * fragment is dropped. Throws `Error` where Python raises `ValueError`.
 */

const SCHEME_CHARS = /^[A-Za-z0-9+\-.]*$/;
/** Schemes for which `urlparse` splits `;params` off the last path segment. */
const USES_PARAMS = new Set([
  "", "ftp", "hdl", "prospero", "http", "imap", "https", "shttp", "rtsp", "rtspu", "sip", "sips", "mms", "sftp", "tel",
]);

export interface ParsedUrl {
  scheme: string;
  netloc: string;
  /** Path with `;params` removed, like `urlparse(...).path`. */
  path: string;
  params: string;
  query: string;
  fragment: string;
}

function checkNetloc(netloc: string): void {
  if (/^[\x00-\x7f]*$/.test(netloc)) return;
  const n = netloc.replace(/[@:#?]/g, "");
  const normalised = n.normalize("NFKC");
  if (n === normalised) return;
  for (const c of "/?#@:") {
    if (normalised.includes(c)) throw new Error(`netloc '${netloc}' contains invalid characters under NFKC normalization`);
  }
}

const HEX4 = /^[0-9A-Fa-f]{1,4}$/;
const DEC_OCTET = /^(?:0|[1-9][0-9]{0,2})$/;

function isIpv4(s: string): boolean {
  const o = s.split(".");
  return o.length === 4 && o.every((x) => DEC_OCTET.test(x) && Number(x) <= 255);
}

/** Python `ipaddress.IPv6Address` acceptance (including a `%scope` suffix). */
function isIpv6(input: string): boolean {
  const pct = input.indexOf("%");
  let addr = input;
  if (pct >= 0) {
    const scope = input.slice(pct + 1);
    if (scope === "" || scope.includes("%") || scope.includes("/")) return false;
    addr = input.slice(0, pct);
  }
  const parts = addr.split(":");
  if (parts.length < 3) return false;
  const last = parts[parts.length - 1] as string;
  if (last.includes(".")) {
    if (!isIpv4(last)) return false;
    parts.splice(parts.length - 1, 1, "0", "0"); // the IPv4 tail occupies two hextets
  }
  if (parts.length > 9) return false;
  let skip = -1;
  for (let i = 1; i < parts.length - 1; i++) {
    if (parts[i] === "") {
      if (skip !== -1) return false;
      skip = i;
    }
  }
  let hextets: string[];
  if (skip !== -1) {
    let hi = skip;
    let lo = parts.length - skip - 1;
    if (parts[0] === "") hi--;
    if (hi > 0 && parts[0] === "") return false;
    if (parts[parts.length - 1] === "") lo--;
    if (lo > 0 && parts[parts.length - 1] === "") return false;
    if (8 - (hi + lo) < 1) return false;
    hextets = parts.filter((x) => x !== ""); // empties are only the "::" gap and its edges, validated above
  } else {
    if (parts.length !== 8) return false;
    if (parts[0] === "" || parts[parts.length - 1] === "") return false;
    hextets = parts;
  }
  return hextets.every((h) => HEX4.test(h));
}

/** Python 3.14 `_check_bracketed_host`. */
function checkBracketedHost(host: string): void {
  if (host.startsWith("v")) {
    if (!/^v[a-fA-F0-9]+\..+$/s.test(host)) throw new Error("IPvFuture address is invalid");
  } else if (!isIpv6(host)) {
    // Python: not an IP at all, or an IPv4 address in brackets.
    throw new Error(`'${host}' is not a bracketable IPv6 address`);
  }
}

/** Python 3.14 `_check_bracketed_netloc`. */
function checkBracketedNetloc(netloc: string): void {
  const hostAndPort = netloc.slice(netloc.lastIndexOf("@") + 1);
  const open = hostAndPort.indexOf("[");
  let hostname: string;
  if (open >= 0) {
    if (open > 0) throw new Error("Invalid IPv6 URL");
    const rest = hostAndPort.slice(open + 1);
    const close = rest.indexOf("]");
    hostname = close >= 0 ? rest.slice(0, close) : rest;
    const port = close >= 0 ? rest.slice(close + 1) : "";
    if (port && !port.startsWith(":")) throw new Error("Invalid IPv6 URL");
  } else {
    const c = hostAndPort.indexOf(":");
    hostname = c >= 0 ? hostAndPort.slice(0, c) : hostAndPort;
  }
  checkBracketedHost(hostname);
}

export function pyUrlParse(input: string): ParsedUrl {
  let url = input.replace(/^[\x00-\x20]+/, "").replace(/[\t\r\n]/g, "");
  let scheme = "";
  const colon = url.indexOf(":");
  if (colon > 0 && /^[A-Za-z]/.test(url) && SCHEME_CHARS.test(url.slice(0, colon))) {
    scheme = url.slice(0, colon).toLowerCase();
    url = url.slice(colon + 1);
  }
  let netloc = "";
  if (url.startsWith("//")) {
    let delim = url.length;
    for (const c of "/?#") {
      const w = url.indexOf(c, 2);
      if (w >= 0 && w < delim) delim = w;
    }
    netloc = url.slice(2, delim);
    url = url.slice(delim);
    if ((netloc.includes("[") && !netloc.includes("]")) || (netloc.includes("]") && !netloc.includes("["))) {
      throw new Error("Invalid IPv6 URL");
    }
    if (netloc.includes("[") && netloc.includes("]")) checkBracketedNetloc(netloc);
    checkNetloc(netloc);
  }
  let fragment = "";
  const hash = url.indexOf("#");
  if (hash >= 0) {
    fragment = url.slice(hash + 1);
    url = url.slice(0, hash);
  }
  let query = "";
  const q = url.indexOf("?");
  if (q >= 0) {
    query = url.slice(q + 1);
    url = url.slice(0, q);
  }
  let params = "";
  if (USES_PARAMS.has(scheme) && url.includes(";")) {
    let i: number;
    if (url.includes("/")) {
      i = url.indexOf(";", url.lastIndexOf("/"));
    } else {
      i = url.indexOf(";");
    }
    if (i >= 0) {
      params = url.slice(i + 1);
      url = url.slice(0, i);
    }
  }
  return { scheme, netloc, path: url, params, query, fragment };
}
