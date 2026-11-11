/**
 * ChatGPT Codex quota client — the client from the original `codex-usage`
 * extension, moved here unchanged (same endpoint, same payload parsing, same
 * messages) so the Codex footer/detail text stays byte-identical.
 *
 * Endpoint discovered by observation, matching the original implementation:
 * `GET https://chatgpt.com/backend-api/wham/usage` with the credential Pi
 * already stored for the `openai-codex` provider. Not a documented public API;
 * failures degrade to `Codex: N/A` rather than breaking the footer.
 */

import type { QuotaSnapshot, QuotaWindow } from "./quota-model.ts";
import { resetText } from "./quota-model.ts";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";

export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const CODEX_CACHE_MS = 60_000;
export const CODEX_TIMEOUT_MS = 5_000;
const LEGACY_UNAVAILABLE = "Codex: N/A (request temporarily unavailable)";

/** Reader injected in tests; in production this is `readStoredCredential`. */
export type CredentialReader = (provider: string) => unknown;
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

interface CodexCredential {
	type?: string;
	access?: string;
	accountId?: string;
	expires?: number;
}

function jwtExpiryMs(token: string): number | undefined {
	try {
		const payload = token.split(".")[1];
		if (!payload) return undefined;
		const json = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as { exp?: number };
		return typeof json.exp === "number" ? json.exp * 1000 : undefined;
	} catch {
		return undefined;
	}
}

/** Legacy-compatible helper: "5h 33% left" / "5h N/A". */
export function remainingLine(name: string, quota?: QuotaWindow): string {
	return quota ? `${name} ${Math.round(100 - quota.used)}% left` : `${name} N/A`;
}

export interface CodexQuotaClient {
	/** Resolves the cached Codex usage, or throws a `Codex: …` message. */
	fetchUsage(force?: boolean): Promise<QuotaSnapshot>;
	/** Last successful Codex usage (even when stale), for stale display. */
	getCache(): QuotaSnapshot | undefined;
	invalidate(): void;
}

export function createQuotaClient(
	readCredential: CredentialReader = readStoredCredential,
	fetcher: Fetcher = fetch,
	now: () => number = Date.now,
): CodexQuotaClient {
	let cached: QuotaSnapshot | undefined;
	let pending: Promise<QuotaSnapshot> | undefined;
	let failedUntil = 0;

	async function fetchUsage(force = false): Promise<QuotaSnapshot> {
		if (!force && cached && now() - cached.fetchedAt < CODEX_CACHE_MS) return cached;
		if (pending) return pending;
		if (now() < failedUntil) throw new Error(LEGACY_UNAVAILABLE);
		pending = (async () => {
			const raw = readCredential("openai-codex") as CodexCredential | undefined;
			if (!raw || raw.type !== "oauth" || !raw.access) throw new Error("Codex: Auth unavailable");
			const exp = raw.expires && raw.expires > 0 ? raw.expires : jwtExpiryMs(raw.access);
			if (exp !== undefined && exp <= now()) throw new Error("Codex: Auth expired");
			const headers: Record<string, string> = { Authorization: `Bearer ${raw.access}`, Accept: "application/json" };
			if (raw.accountId) headers["ChatGPT-Account-Id"] = raw.accountId;
			let response: Response;
			try {
				response = await fetcher(USAGE_URL, { headers, signal: AbortSignal.timeout(CODEX_TIMEOUT_MS) });
			} catch {
				failedUntil = now() + CODEX_CACHE_MS;
				throw new Error("Codex: N/A (usage request failed)");
			}
			if (response.status === 401 || response.status === 403) {
				failedUntil = now() + CODEX_CACHE_MS;
				throw new Error("Codex: Auth expired");
			}
			if (!response.ok) {
				failedUntil = now() + CODEX_CACHE_MS;
				throw new Error("Codex: N/A (usage service unavailable)");
			}
			let body: {
				plan_type?: string;
				rate_limit?: {
					limit_reached?: boolean;
					primary_window?: { used_percent?: number; reset_at?: number; limit_window_seconds?: number };
					secondary_window?: { used_percent?: number; reset_at?: number; limit_window_seconds?: number };
				};
			};
			try {
				body = (await response.json()) as typeof body;
			} catch {
				failedUntil = now() + CODEX_CACHE_MS;
				throw new Error("Codex: N/A (invalid usage response)");
			}
			const windows = [body?.rate_limit?.primary_window, body?.rate_limit?.secondary_window].filter(Boolean);
			const usage: QuotaSnapshot = {
				provider: "codex",
				source: "endpoint",
				fetchedAt: now(),
				plan: body?.plan_type,
				limitReached: body?.rate_limit?.limit_reached,
			};
			for (const window of windows) {
				if (!window || typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent)) continue;
				const quota = { used: Math.max(0, Math.min(100, window.used_percent)), resetAt: typeof window.reset_at === "number" ? window.reset_at * 1000 : 0 };
				if ((window.limit_window_seconds ?? 0) <= 21600) usage.fiveHour = quota;
				else usage.weekly = quota;
			}
			if (!usage.fiveHour && !usage.weekly) throw new Error("Codex: N/A (quota windows missing)");
			cached = usage;
			failedUntil = 0;
			return usage;
		})().finally(() => {
			pending = undefined;
		});
		return pending;
	}

	return {
		fetchUsage,
		getCache: () => cached,
		invalidate: () => {
			cached = undefined;
			failedUntil = 0;
		},
	};
}

/** Legacy footer text: `Codex 5h 95% left · W 55% left`. */
export function compactStatus(usage: QuotaSnapshot): string {
	const left = (quota?: QuotaWindow) => (quota ? `${Math.round(100 - quota.used)}% left` : "N/A");
	return `Codex 5h ${left(usage.fiveHour)} · W ${left(usage.weekly)}`;
}

/** Legacy detail text for /codex-quota, kept byte-identical. */
export function detailed(usage: QuotaSnapshot, now: number = Date.now()): string {
	const line = (label: string, quota?: QuotaWindow) =>
		quota ? `${label}: ${quota.used.toFixed(1)}% used · ${(100 - quota.used).toFixed(1)}% remaining · resets in ${resetText(quota.resetAt, now)}` : `${label}: N/A`;
	return ["Codex quota", line("5-hour", usage.fiveHour), line("Weekly", usage.weekly), ...(usage.plan ? [`Plan: ${usage.plan}`] : []), ...(usage.limitReached ? ["Rate limit reached"] : [])].join("\n");
}

/** Footer text when the fetch failed: legacy kept only auth messages. */
export function legacyErrorStatus(message: string): string {
	return message.startsWith("Codex: Auth") ? message : "Codex: N/A";
}
