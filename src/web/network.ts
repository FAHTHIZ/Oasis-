/**
 * SSRF-hardened outbound HTTP for requests made on the model's behalf
 * (ported from OASIS 1.x safe-http and network-safety).
 *
 * - Local hostnames and non-public IP literals are refused. Address parsing
 *   is done by ipaddr.js, so every IPv4/IPv6 spelling (compressed,
 *   zone-scoped, IPv4-mapped, NAT64) goes through one policy table.
 * - A hostname is resolved once, every answer is checked, and the socket's
 *   lookup is pinned to exactly those answers, so DNS rebinding can't swap
 *   in an internal address between check and connect.
 * - Bodies are bounded by Content-Length and while streaming; every request
 *   has a timeout and honours an AbortSignal.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";

const cidrs = (list: string[]) => list.map((c) => ipaddr.parseCIDR(c));

// IANA special-purpose IPv4 registry plus conservative extras.
const NON_PUBLIC_IPV4 = cidrs([
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.0.0.0/24",
	"192.0.2.0/24",
	"192.88.99.0/24",
	"192.168.0.0/16",
	"198.18.0.0/15",
	"198.51.100.0/24",
	"203.0.113.0/24",
	"224.0.0.0/4",
	"240.0.0.0/4",
]);
// Anything outside 2000::/3 (global unicast) is rejected too.
const NON_PUBLIC_IPV6 = cidrs([
	"64:ff9b:1::/48",
	"2001::/23",
	"2001:db8::/32",
	"2001:4:112::/48",
	"2002::/16",
	"3fff::/16",
	"fc00::/7",
	"fe00::/8",
	"ff00::/8",
]);
const GLOBAL_UNICAST = ipaddr.parseCIDR("2000::/3");
const NAT64 = ipaddr.parseCIDR("64:ff9b::/96");

type Addr = ipaddr.IPv4 | ipaddr.IPv6;
const inAny = (a: Addr, ranges: [Addr, number][]) => ranges.some((r) => a.kind() === r[0].kind() && a.match(r));

function parse(raw: string): Addr | null {
	let value = raw.trim().replace(/^\[|\]$/g, "");
	const zone = value.indexOf("%");
	if (zone !== -1) value = value.slice(0, zone);
	// Strict forms only: legacy inet_aton spellings ("0x7f.1") are not IP literals here.
	if (ipaddr.IPv4.isValidFourPartDecimal(value)) return ipaddr.IPv4.parse(value);
	if (!value.includes(":")) return null;
	// Keep "::a.b.c.d" (IPv4-compatible) distinct from "::ffff:a.b.c.d" (mapped).
	const dotted = value.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
	if (dotted) {
		if (!ipaddr.IPv4.isValidFourPartDecimal(dotted[2] as string)) return null;
		const [a, b, c, d] = ipaddr.IPv4.parse(dotted[2] as string).octets as [number, number, number, number];
		value = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	return ipaddr.IPv6.isValid(value) ? ipaddr.IPv6.parse(value) : null;
}

/** True for addresses that are not public Internet destinations. Hostnames return false. */
export function isNonPublicIp(raw: string): boolean {
	const text = raw.trim().replace(/^\[|\]$/g, "");
	const a = parse(text);
	if (!a) return /^\d+\.\d+\.\d+\.\d+$/.test(text) || text.includes(":");
	if (a.kind() === "ipv4") return inAny(a, NON_PUBLIC_IPV4);
	const v6 = a as ipaddr.IPv6;
	if (v6.isIPv4MappedAddress()) return inAny(v6.toIPv4Address(), NON_PUBLIC_IPV4);
	if (v6.match(NAT64)) return inAny(new ipaddr.IPv4(v6.toByteArray().slice(12)), NON_PUBLIC_IPV4);
	if (v6.parts.slice(0, 6).every((w) => w === 0)) return true;
	if (!v6.match(GLOBAL_UNICAST)) return true;
	return inAny(v6, NON_PUBLIC_IPV6);
}

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

export const normalizeHostname = (host: string) =>
	host
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.+$/, "");

export function isLocalHostname(host: string): boolean {
	const name = normalizeHostname(host);
	return name === "localhost" || name === "metadata.google.internal" || LOCAL_SUFFIXES.some((s) => name.endsWith(s));
}

export const isBlockedAddress = (address: string) => {
	const text = address.replace(/^\[|\]$/g, "");
	const v = isIP(text);
	return (v !== 4 && v !== 6) || isNonPublicIp(text);
};

export interface ResolvedAddress {
	address: string;
	family: number;
}
export type Lookup = (host: string, options: { all: true; verbatim: true }) => Promise<{ address: string; family: number }[]>;

export class BlockedUrlError extends Error {}

/** Validate a URL the model asked for and pin the DNS answers that passed. */
export async function vetPublicUrl(
	raw: string,
	lookup: Lookup = dnsLookup as Lookup,
): Promise<{ url: URL; addresses: ResolvedAddress[] | null }> {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new BlockedUrlError("Provide a valid http(s) URL.");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedUrlError("Only http and https URLs can be fetched.");
	if (url.username || url.password) throw new BlockedUrlError("URLs containing credentials are blocked.");
	const host = normalizeHostname(url.hostname);
	if (!host) throw new BlockedUrlError("Provide a valid http(s) URL.");
	if (isLocalHostname(host)) throw new BlockedUrlError("Local and cloud-metadata hosts are blocked.");
	if (isIP(host)) {
		if (isBlockedAddress(host)) throw new BlockedUrlError("Private-network addresses are blocked.");
		return { url, addresses: null };
	}
	let records: { address: string; family: number }[];
	try {
		records = await lookup(host, { all: true, verbatim: true });
	} catch {
		throw new BlockedUrlError(`Could not resolve ${host}.`);
	}
	if (!records.length) throw new BlockedUrlError(`Could not resolve ${host}.`);
	if (records.some((r) => isBlockedAddress(r.address)))
		throw new BlockedUrlError(`${host} resolves to a private or reserved address, so it is blocked.`);
	return { url, addresses: records.map((r) => ({ address: r.address, family: r.family || isIP(r.address) })) };
}

export interface HttpResponse {
	status: number;
	headers: Headers;
	body: Buffer;
	tooLarge: boolean;
}

export interface PinnedRequestOptions {
	addresses?: ResolvedAddress[] | null;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	maxBytes?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
}

/** One HTTP(S) request without redirects, connecting only to the vetted addresses. */
export function pinnedRequest(url: URL, options: PinnedRequestOptions = {}): Promise<HttpResponse> {
	const { addresses, method = "GET", headers = {}, body, maxBytes = 1024 * 1024, timeoutMs = 15_000, signal } = options;
	const hostname = normalizeHostname(url.hostname);
	const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error: Error | null, value?: HttpResponse) => {
			if (settled) return;
			settled = true;
			if (error) reject(error);
			else resolve(value as HttpResponse);
		};
		const lookup: LookupFunction | undefined =
			addresses?.length && !isIP(hostname)
				? (_host, opts, callback) => {
						const first = addresses[0] as ResolvedAddress;
						if ((opts as { all?: boolean }).all) (callback as unknown as (e: null, a: ResolvedAddress[]) => void)(null, addresses);
						else callback(null, first.address, first.family);
					}
				: undefined;
		const req = transport(
			{
				protocol: url.protocol,
				hostname,
				port: url.port || undefined,
				method,
				path: url.pathname + url.search,
				headers,
				signal,
				...(url.protocol === "https:" && !isIP(hostname) ? { servername: hostname } : {}),
				...(lookup ? { lookup } : {}),
			},
			(res) => {
				const status = res.statusCode ?? 0;
				const responseHeaders = new Headers();
				for (const [k, v] of Object.entries(res.headers)) {
					if (v === undefined) continue;
					for (const item of Array.isArray(v) ? v : [v]) responseHeaders.append(k, String(item));
				}
				const tooLarge = () => {
					finish(null, { status, headers: responseHeaders, body: Buffer.alloc(0), tooLarge: true });
					res.destroy();
				};
				res.on("error", (e) => finish(e));
				const declared = Number(responseHeaders.get("content-length") ?? 0);
				if (Number.isFinite(declared) && declared > maxBytes) return tooLarge();
				const chunks: Buffer[] = [];
				let total = 0;
				res.on("data", (chunk: Buffer) => {
					if (settled) return;
					total += chunk.length;
					if (total > maxBytes) return tooLarge();
					chunks.push(chunk);
				});
				res.on("end", () => finish(null, { status, headers: responseHeaders, body: Buffer.concat(chunks, total), tooLarge: false }));
			},
		);
		req.on("error", (e) => finish(e));
		req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timed out after ${timeoutMs / 1000}s.`)));
		req.end(body);
	});
}
