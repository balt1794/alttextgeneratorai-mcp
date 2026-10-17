import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export const BLOCKED_MESSAGE = "For safety, only public web pages can be scanned, not local or private network addresses.";
export const TOO_LARGE_MESSAGE = "The page is too large to scan (over 3 MB).";
const MAX_REDIRECTS = 5;

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb") || v.startsWith("fc") || v.startsWith("fd")) return true;
    if (v.startsWith("::ffff:")) {
      const tail = v.slice(7);
      return net.isIPv4(tail) ? isPrivateAddress(tail) : true;
    }
    return false;
  }
  return true;
}

function isLocalName(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal");
}

// The address is checked at the moment the connection is made, so the address that was
// checked is the address that is used (a hostname cannot answer differently the second time).
function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: dns.LookupOptions, callback: (...args: any[]) => void) => {
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const list = addresses as dns.LookupAddress[];
      if (!allowPrivate && (list.length === 0 || list.some((entry) => isPrivateAddress(entry.address)))) {
        return callback(new Error(BLOCKED_MESSAGE));
      }
      if (options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

type PageResponse = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };

function requestOnce(url: URL, allowPrivate: boolean, userAgent: string, maxBytes: number): Promise<PageResponse> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const request = lib.request(
      url,
      {
        method: "GET",
        headers: { "User-Agent": userAgent, Accept: "text/html,application/xhtml+xml", "Accept-Encoding": "identity" },
        lookup: guardedLookup(allowPrivate) as any,
        timeout: 20_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            request.destroy(new Error(TOO_LARGE_MESSAGE));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks) }));
        response.on("error", reject);
      }
    );
    request.on("timeout", () => request.destroy(Object.assign(new Error("timeout"), { name: "TimeoutError" })));
    request.on("error", reject);
    request.end();
  });
}

// Reads a public web page. Local and private network addresses are refused, for the first
// address and for every redirect, and the check is made when the connection is opened.
export async function fetchPublicPage(startUrl: string, allowPrivate: boolean, userAgent: string, maxBytes: number): Promise<PageResponse> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = new URL(current);
    if (!/^https?:$/.test(url.protocol)) throw new Error("The page address must start with http:// or https://");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!allowPrivate && (net.isIP(host) ? isPrivateAddress(host) : isLocalName(host))) throw new Error(BLOCKED_MESSAGE);

    const response = await requestOnce(url, allowPrivate, userAgent, maxBytes);
    const location = response.headers.location;
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, url).toString();
      continue;
    }
    return response;
  }
  throw new Error("The page redirected too many times.");
}
