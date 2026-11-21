import dns from "node:dns/promises";
import http, { type IncomingHttpHeaders } from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { commandExists, type KkConfig, KkError, runCommand } from "@kk-mcp-kit/core";

export type AddressFamily = "auto" | "ipv4" | "ipv6";

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

function normalizeHost(hostname: string): string {
  return hostname
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

function hostMatches(pattern: string, hostname: string): boolean {
  const expected = normalizeHost(pattern);
  const actual = normalizeHost(hostname);
  if (expected.startsWith("*.")) {
    const suffix = expected.slice(1);
    return actual.endsWith(suffix) && actual.length > suffix.length;
  }
  return expected === actual;
}

export function assertAllowedHost(config: KkConfig, hostname: string): string {
  const normalized = normalizeHost(hostname);
  if (
    !normalized ||
    !config.servers.networkForensics.allowedHosts.some((item) => hostMatches(item, normalized))
  ) {
    throw new KkError("PERMISSION_DENIED", `Host is not allowed: ${hostname}`, {
      details: { hostname, allowedHosts: config.servers.networkForensics.allowedHosts },
    });
  }
  return normalized;
}

export function parseAllowedUrl(config: KkConfig, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new KkError("INVALID_ARGUMENT", "A valid absolute HTTP(S) URL is required", {
      cause: error,
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new KkError("INVALID_ARGUMENT", "Only http: and https: URLs are supported");
  }
  if (url.username || url.password) {
    throw new KkError("PERMISSION_DENIED", "Credentials in URLs are not accepted");
  }
  for (const key of url.searchParams.keys()) {
    if (/(?:auth|credential|key|password|secret|signature|token)/i.test(key)) {
      throw new KkError(
        "PERMISSION_DENIED",
        `Credential-like URL query parameter is not accepted: ${key}`,
      );
    }
  }
  assertAllowedHost(config, url.hostname);
  return url;
}

function familyNumber(family: AddressFamily): 0 | 4 | 6 {
  if (family === "ipv4") return 4;
  if (family === "ipv6") return 6;
  return 0;
}

export async function resolvePinned(
  config: KkConfig,
  hostname: string,
  family: AddressFamily = "auto",
): Promise<ResolvedAddress[]> {
  const allowed = assertAllowedHost(config, hostname);
  const literal = net.isIP(allowed);
  if (literal) {
    if (family === "ipv4" && literal !== 4) return [];
    if (family === "ipv6" && literal !== 6) return [];
    return [{ address: allowed, family: literal as 4 | 6 }];
  }
  const records = await dns.lookup(allowed, {
    all: true,
    verbatim: true,
    family: familyNumber(family),
  });
  const unique = new Map(records.map((record) => [record.address, record.family as 4 | 6]));
  return [...unique].map(([address, addressFamily]) => ({ address, family: addressFamily }));
}

export async function inspectDns(
  config: KkConfig,
  hostname: string,
  family: AddressFamily = "auto",
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const addresses = await resolvePinned(config, hostname, family);
  if (addresses.length === 0)
    throw new KkError("UNSUPPORTED_BACKEND", `No ${family} address found`);
  const allowed = assertAllowedHost(config, hostname);
  const [cname, mx, txt] = await Promise.all([
    dns.resolveCname(allowed).catch(() => []),
    dns.resolveMx(allowed).catch(() => []),
    dns
      .resolveTxt(allowed)
      .then((rows) => rows.map((row) => row.join("")))
      .catch(() => []),
  ]);
  return {
    hostname: allowed,
    family,
    addresses,
    cname: cname.slice(0, 50),
    mx: mx.slice(0, 50),
    txt: txt.slice(0, 50).map((value) => value.slice(0, 512)),
    durationMs: Date.now() - startedAt,
  };
}

function certificateSummary(certificate: tls.PeerCertificate): Record<string, unknown> | null {
  if (!certificate || Object.keys(certificate).length === 0) return null;
  return {
    subject: certificate.subject,
    issuer: certificate.issuer,
    subjectAltName: certificate.subjectaltname ?? null,
    validFrom: certificate.valid_from,
    validTo: certificate.valid_to,
    fingerprint256: certificate.fingerprint256,
    serialNumber: certificate.serialNumber,
  };
}

export async function inspectTls(
  config: KkConfig,
  hostname: string,
  port = 443,
  family: AddressFamily = "auto",
): Promise<Record<string, unknown>> {
  const addresses = await resolvePinned(config, hostname, family);
  const selected = addresses[0];
  if (!selected) throw new KkError("UNSUPPORTED_BACKEND", `No ${family} address found`);
  const servername = assertAllowedHost(config, hostname);
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: selected.address,
      port,
      rejectUnauthorized: true,
      ...(net.isIP(servername) ? {} : { servername }),
    });
    const timeout = setTimeout(() => {
      socket.destroy(
        new KkError("TIMEOUT", `TLS connection exceeded ${config.limits.defaultTimeoutMs}ms`),
      );
    }, config.limits.defaultTimeoutMs);
    timeout.unref();
    socket.once("secureConnect", () => {
      clearTimeout(timeout);
      const result = {
        hostname: servername,
        address: selected.address,
        family: selected.family,
        port,
        authorized: socket.authorized,
        authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
        protocol: socket.getProtocol(),
        cipher: socket.getCipher(),
        alpnProtocol: socket.alpnProtocol || null,
        certificate: certificateSummary(socket.getPeerCertificate()),
        durationMs: Date.now() - startedAt,
      };
      socket.end();
      resolve(result);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

const SAFE_RESPONSE_HEADERS = new Set([
  "age",
  "cache-control",
  "content-length",
  "content-type",
  "date",
  "etag",
  "expires",
  "last-modified",
  "location",
  "server",
  "strict-transport-security",
  "via",
  "x-cache",
  "x-request-id",
]);

function boundedHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!SAFE_RESPONSE_HEADERS.has(key) || value === undefined) continue;
    result[key] = Array.isArray(value) ? value.slice(0, 10) : String(value).slice(0, 2_048);
  }
  return result;
}

async function requestHop(
  config: KkConfig,
  url: URL,
  method: "HEAD" | "GET",
  family: AddressFamily,
): Promise<Record<string, unknown>> {
  const addresses = await resolvePinned(config, url.hostname, family);
  const selected = addresses[0];
  if (!selected) throw new KkError("UNSUPPORTED_BACKEND", `No ${family} address found`);
  const startedAt = Date.now();
  const timings: Record<string, number> = { start: 0 };
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method,
        agent: false,
        servername: net.isIP(url.hostname) ? undefined : url.hostname,
        headers: {
          accept: "*/*",
          "user-agent": "kk-mcp-network-forensics/0.1",
        },
        lookup: (_hostname, _options, callback) => {
          callback(null, selected.address, selected.family);
        },
      },
      (response) => {
        timings.firstByte = Date.now() - startedAt;
        response.resume();
        resolve({
          url: url.href,
          method,
          address: selected.address,
          family: selected.family,
          status: response.statusCode ?? null,
          statusMessage: response.statusMessage ?? null,
          headers: boundedHeaders(response.headers),
          timings,
        });
      },
    );
    request.once("socket", (socket) => {
      socket.once("lookup", () => {
        timings.dns = Date.now() - startedAt;
      });
      socket.once("connect", () => {
        timings.tcp = Date.now() - startedAt;
      });
      if (socket instanceof tls.TLSSocket) {
        socket.once("secureConnect", () => {
          timings.tls = Date.now() - startedAt;
        });
      }
    });
    request.setTimeout(config.limits.defaultTimeoutMs, () => {
      timedOut = true;
      request.destroy();
    });
    request.once("error", (error) => {
      reject(
        timedOut
          ? new KkError("TIMEOUT", `HTTP request exceeded ${config.limits.defaultTimeoutMs}ms`)
          : error,
      );
    });
    request.end();
  });
}

export async function traceHttp(
  config: KkConfig,
  rawUrl: string,
  method: "HEAD" | "GET" = "HEAD",
  family: AddressFamily = "auto",
): Promise<Record<string, unknown>> {
  let url = parseAllowedUrl(config, rawUrl);
  const hops: Array<Record<string, unknown>> = [];
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const hop = await requestHop(config, url, method, family);
    hops.push(hop);
    const status = Number(hop.status);
    const headers = hop.headers as Record<string, string | string[]>;
    const locationValue = headers.location;
    const location = Array.isArray(locationValue) ? locationValue[0] : locationValue;
    if (!location || ![301, 302, 303, 307, 308].includes(status)) {
      return { requestedUrl: rawUrl, finalUrl: url.href, redirects: hops.length - 1, hops };
    }
    if (redirect === 5) throw new KkError("OUTPUT_LIMIT", "HTTP redirect limit exceeded");
    url = parseAllowedUrl(config, new URL(location, url).href);
  }
  throw new KkError("INTERNAL_ERROR", "Unreachable redirect state");
}

export async function traceRoute(
  config: KkConfig,
  hostname: string,
  maxHops: number,
): Promise<Record<string, unknown>> {
  const addresses = await resolvePinned(config, hostname);
  const selected = addresses[0];
  if (!selected) throw new KkError("UNSUPPORTED_BACKEND", "No route target address found");
  let command: string;
  let args: string[];
  if (process.platform === "win32") {
    command = "tracert.exe";
    args = ["-d", "-h", String(maxHops), selected.address];
  } else if (await commandExists("traceroute")) {
    command = "traceroute";
    args = ["-n", "-m", String(maxHops), selected.address];
  } else if (await commandExists("tracepath")) {
    command = "tracepath";
    args = ["-n", "-m", String(maxHops), selected.address];
  } else {
    throw new KkError("UNSUPPORTED_BACKEND", "No traceroute, tracepath, or tracert backend found");
  }
  const result = await runCommand(command, args, {
    timeoutMs: Math.min(config.limits.defaultTimeoutMs, 120_000),
    maxOutputBytes: config.limits.maxOutputBytes,
    allowNonZero: true,
  });
  return {
    hostname: assertAllowedHost(config, hostname),
    address: selected.address,
    backend: command,
    exitCode: result.exitCode,
    hops: result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(0, maxHops + 5),
    stderr: result.stderr,
    truncated: result.truncated,
  };
}

export function inspectProxyEnvironment(): Record<string, unknown> {
  const names = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"] as const;
  return Object.fromEntries(
    names.map((name) => {
      const value = process.env[name] ?? process.env[name.toLowerCase()];
      if (!value) return [name, { configured: false }];
      if (name === "NO_PROXY") {
        return [
          name,
          {
            configured: true,
            entries: value.split(",").filter(Boolean).length,
            value: "[REDACTED]",
          },
        ];
      }
      try {
        const url = new URL(value);
        return [
          name,
          {
            configured: true,
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || null,
            credentialsRedacted: Boolean(url.username || url.password),
          },
        ];
      } catch {
        return [name, { configured: true, value: "[REDACTED_UNPARSEABLE_PROXY]" }];
      }
    }),
  );
}

export async function networkCapabilities(): Promise<Record<string, unknown>> {
  const routeBackend =
    process.platform === "win32"
      ? (await commandExists("tracert.exe"))
        ? "tracert"
        : null
      : (await commandExists("traceroute"))
        ? "traceroute"
        : (await commandExists("tracepath"))
          ? "tracepath"
          : null;
  return {
    platform: process.platform,
    dns: "node:dns",
    tls: "node:tls",
    http: "node:http/node:https",
    routeBackend,
    rawPacketCapture: false,
  };
}
