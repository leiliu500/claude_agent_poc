/**
 * Egress guard for the generic HTTP proxy.
 *
 * A backend's `baseUrl` is attacker-influenced input: applications are registered at runtime by
 * dropping a document in S3, and the proxy then calls `baseUrl + path` from a Lambda inside the VPC.
 * Without a check, a registration document naming `http://169.254.169.254/...` turns the gateway
 * into a confused deputy that reads the instance metadata service — the textbook SSRF pivot to
 * credentials — and any RFC1918 address reaches services that are only reachable because we are
 * inside the network.
 *
 * The default policy is therefore: public, HTTPS destinations only. It is enforced at registration
 * (so a bad document is rejected at the door, where the error is actionable) AND immediately before
 * the request is issued (so a URL that changed in the database, or a redirect target, cannot slip
 * past a check that ran earlier).
 *
 * GATEWAY_ALLOW_INSECURE_EGRESS=true relaxes it for a local/dev host that genuinely serves over
 * plain HTTP on localhost. It is an explicit, named opt-out rather than a silent default.
 */

/** Literal IPv4 ranges that must never be a backend target. */
const BLOCKED_V4 = [
  { name: "loopback", test: (o: number[]) => o[0] === 127 },
  { name: "link-local / instance metadata", test: (o: number[]) => o[0] === 169 && o[1] === 254 },
  { name: "private (10/8)", test: (o: number[]) => o[0] === 10 },
  { name: "private (172.16/12)", test: (o: number[]) => o[0] === 172 && (o[1] ?? 0) >= 16 && (o[1] ?? 0) <= 31 },
  { name: "private (192.168/16)", test: (o: number[]) => o[0] === 192 && o[1] === 168 },
  { name: "carrier-grade NAT (100.64/10)", test: (o: number[]) => o[0] === 100 && (o[1] ?? 0) >= 64 && (o[1] ?? 0) <= 127 },
  { name: "this-network (0/8)", test: (o: number[]) => o[0] === 0 },
  { name: "broadcast / reserved", test: (o: number[]) => (o[0] ?? 0) >= 224 },
];

/** Hostnames that resolve to the local host regardless of DNS. */
const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);

const allowInsecure = (): boolean => process.env.GATEWAY_ALLOW_INSECURE_EGRESS === "true";

/** Parse a dotted-quad into octets, or undefined when the host is not a literal IPv4 address. */
function ipv4Octets(host: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return undefined;
  const octets = m.slice(1, 5).map((n) => Number(n));
  return octets.every((n) => n >= 0 && n <= 255) ? octets : undefined;
}

/**
 * The IPv4 address behind an IPv4-mapped IPv6 literal, if any.
 *
 * WHY THIS IS NOT JUST A DOTTED-QUAD MATCH: the URL parser normalises `::ffff:169.254.169.254` to
 * the hex form `::ffff:a9fe:a9fe`, so a guard that only looks for dotted quads lets the metadata
 * service straight through. Both spellings are handled here.
 */
function mappedIpv4(host: string): number[] | undefined {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(host);
  if (dotted?.[1]) return ipv4Octets(dotted[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (!hex) return undefined;
  const hi = parseInt(hex[1] as string, 16);
  const lo = parseInt(hex[2] as string, 16);
  return [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255];
}

/** The blocked-range reason for a literal address, or undefined when it is not in one. */
function blockedRange(octets: number[]): string | undefined {
  for (const range of BLOCKED_V4) {
    if (range.test(octets)) return range.name;
  }
  return undefined;
}

/**
 * Why a URL is not an acceptable egress target, or undefined when it is.
 *
 * Returns a reason string rather than throwing so both call sites can decide how to surface it —
 * registration rejects with it, the proxy refuses the call with it.
 *
 * ORDER MATTERS. The address checks run before the plain-http check so that a blocked destination
 * is reported by its real danger ("link-local / instance metadata") rather than by whichever
 * cosmetic rule happened to match first. Both would refuse the call; only one explains it.
 */
export function egressRejection(rawUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return `'${rawUrl}' is not a valid absolute URL.`;
  }

  // Scheme first: for a non-HTTP scheme there is no meaningful host to reason about, and file:,
  // gopher: and ftp: are classic SSRF escapes.
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return `scheme '${url.protocol.replace(":", "")}' is not allowed; use https.`;
  }

  // Credentials in the URL are both a leak (they end up in logs) and a redirect-abuse vector.
  if (url.username || url.password) return "credentials embedded in the URL are not allowed.";

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return "the URL has no host.";

  const loopbackHost = BLOCKED_HOSTS.has(host) || host === "::1";
  if (loopbackHost && !allowInsecure()) {
    return `host '${host}' is loopback and is not an allowed target.`;
  }
  if (host.startsWith("fe80:")) return "host is IPv6 link-local and is not an allowed target.";
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return "host is an IPv6 unique-local address and is not an allowed target.";

  const octets = ipv4Octets(host) ?? mappedIpv4(host);
  if (octets) {
    const range = blockedRange(octets);
    // The dev opt-out covers loopback only. It exists so a local server on 127.0.0.1 is reachable —
    // never so the credential endpoint or the private network becomes reachable.
    if (range && !(allowInsecure() && range === "loopback")) {
      return `host '${host}' is in a blocked range (${range}) and is not an allowed target.`;
    }
  }

  if (url.protocol === "http:" && !allowInsecure()) {
    return "plain http is not allowed; use https (set GATEWAY_ALLOW_INSECURE_EGRESS=true for a local dev host).";
  }

  return undefined;
}

/** Convenience wrapper for call sites that want to fail hard. */
export function assertEgressAllowed(rawUrl: string, context: string): void {
  const reason = egressRejection(rawUrl);
  if (reason) throw new Error(`${context}: ${reason}`);
}
