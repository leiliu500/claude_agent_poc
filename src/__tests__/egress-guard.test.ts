/**
 * Egress guard for the generic HTTP proxy.
 *
 * A backend's baseUrl is attacker-influenced: applications are registered at runtime by dropping a
 * document in S3, and the proxy then calls that URL from a Lambda inside the VPC. The cases pinned
 * here are the ones that turn the gateway into a confused deputy — above all the instance metadata
 * service, which is the standard SSRF pivot to credentials.
 */
import { describe, it, expect, afterEach } from "vitest";
import { egressRejection, assertEgressAllowed } from "../shared/gateway/egress.js";

afterEach(() => {
  delete process.env.GATEWAY_ALLOW_INSECURE_EGRESS;
});

describe("egress guard: destinations that must be refused", () => {
  it("refuses the instance metadata service", () => {
    // The one that matters most: reading it yields role credentials.
    expect(egressRejection("http://169.254.169.254/latest/meta-data/")).toBeTruthy();
    expect(egressRejection("https://169.254.169.254/")).toContain("link-local");
  });

  it("refuses an IPv4-mapped IPv6 literal for the same address", () => {
    // ::ffff:169.254.169.254 reaches exactly the same place as the dotted quad.
    expect(egressRejection("https://[::ffff:169.254.169.254]/latest/meta-data/")).toContain("link-local");
  });

  it("refuses loopback in every spelling", () => {
    expect(egressRejection("https://127.0.0.1/")).toContain("loopback");
    expect(egressRejection("https://127.99.1.2/")).toContain("loopback");
    expect(egressRejection("https://localhost/")).toContain("loopback");
    expect(egressRejection("https://[::1]/")).toContain("loopback");
  });

  it("refuses RFC1918 private ranges", () => {
    expect(egressRejection("https://10.0.0.5/")).toContain("private");
    expect(egressRejection("https://172.16.4.4/")).toContain("private");
    expect(egressRejection("https://172.31.255.1/")).toContain("private");
    expect(egressRejection("https://192.168.1.1/")).toContain("private");
  });

  it("allows 172.32.x, which is public despite looking adjacent to the private block", () => {
    // Guards that test the first octet alone get this wrong in the unsafe direction.
    expect(egressRejection("https://172.32.0.1/")).toBeUndefined();
    expect(egressRejection("https://172.15.0.1/")).toBeUndefined();
  });

  it("refuses carrier-grade NAT, 0/8 and multicast/reserved space", () => {
    expect(egressRejection("https://100.64.0.1/")).toContain("carrier-grade");
    expect(egressRejection("https://0.0.0.0/")).toContain("this-network");
    expect(egressRejection("https://239.1.1.1/")).toContain("reserved");
  });

  it("refuses IPv6 link-local and unique-local", () => {
    expect(egressRejection("https://[fe80::1]/")).toContain("link-local");
    expect(egressRejection("https://[fd00::1]/")).toContain("unique-local");
  });

  it("refuses non-http schemes", () => {
    expect(egressRejection("file:///etc/passwd")).toContain("not allowed");
    expect(egressRejection("gopher://example.com/")).toContain("not allowed");
    expect(egressRejection("ftp://example.com/")).toContain("not allowed");
  });

  it("refuses plain http by default", () => {
    expect(egressRejection("http://example.com/")).toContain("plain http");
  });

  it("refuses credentials embedded in the URL", () => {
    // They leak into logs and survive a redirect.
    expect(egressRejection("https://user:pass@example.com/")).toContain("credentials");
  });

  it("refuses anything that is not a valid absolute URL", () => {
    expect(egressRejection("not a url")).toBeTruthy();
    expect(egressRejection("/relative/path")).toBeTruthy();
    expect(egressRejection("")).toBeTruthy();
  });
});

describe("egress guard: destinations that must be allowed", () => {
  it("allows an ordinary public https backend", () => {
    expect(egressRejection("https://api.example.com/v1")).toBeUndefined();
    expect(egressRejection("https://8.8.8.8/")).toBeUndefined();
  });

  it("allows the backends this deployment actually registers", () => {
    // Private DNS names over https. NOTE the real limitation: a hostname that RESOLVES to a private
    // address is not caught here — resolving at check time would only invite a rebinding race.
    expect(egressRejection("https://fedline.frb.pvt")).toBeUndefined();
    expect(egressRejection("https://dg2-scp.dev.fedcash-iface1.awscfs.frb.pvt")).toBeUndefined();
  });
});

describe("egress guard: the explicit dev opt-out", () => {
  it("permits http and loopback only when named explicitly", () => {
    expect(egressRejection("http://localhost:3000/")).toBeTruthy();
    process.env.GATEWAY_ALLOW_INSECURE_EGRESS = "true";
    expect(egressRejection("http://localhost:3000/")).toBeUndefined();
    expect(egressRejection("http://127.0.0.1:3000/")).toBeUndefined();
  });

  it("still refuses the metadata service even with the opt-out set", () => {
    // The dev escape hatch is for a local server, never for the credential endpoint.
    process.env.GATEWAY_ALLOW_INSECURE_EGRESS = "true";
    expect(egressRejection("http://169.254.169.254/latest/meta-data/")).toContain("link-local");
  });

  it("still refuses private ranges with the opt-out set", () => {
    process.env.GATEWAY_ALLOW_INSECURE_EGRESS = "true";
    expect(egressRejection("http://10.0.0.5/")).toContain("private");
  });
});

describe("assertEgressAllowed", () => {
  it("throws with the caller's context so the log says which backend was refused", () => {
    expect(() => assertEgressAllowed("http://169.254.169.254/", "Refusing to call evil/getThing"))
      .toThrow(/Refusing to call evil\/getThing:.*link-local/);
  });

  it("does not throw for an allowed destination", () => {
    expect(() => assertEgressAllowed("https://api.example.com/", "ctx")).not.toThrow();
  });
});
