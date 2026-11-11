/**
 * Persisted quota preferences + provider/mode resolution.
 *
 * Settings are stored in the Pi agent directory as `<agentDir>/quota-usage.json`
 * (Pi has no extension-writable settings API, and `settings.json` stays the
 * user's file). The file contains no credentials — only mode and provider ids.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { QuotaMode, QuotaProvider } from "./quota-model.ts";

export const QUOTA_SETTINGS_FILE = "quota-usage.json";

/** Re-exported so mode constants and their type live in one place. */
export type { QuotaMode } from "./quota-model.ts";

export type SubscriptionProvider = "anthropic" | "openai-codex";
/**
 * What a stored credential can do for quota display:
 * - `usable` — OAuth login that can read usage data
 * - `oauth-no-usage` — OAuth login whose granted scopes are known not to include
 *   any Claude usage scope (footer still shows the account, the detailed view
 *   explains that the login predates the usage endpoint)
 * - `api-key` — API-key login (no subscription usage to show)
 * - `none` — not logged in
 */
export type CredentialKind = "usable" | "oauth-no-usage" | "api-key" | "none";

export interface QuotaSettings {
	version: 1;
	mode: QuotaMode;
	lastSubscriptionProvider: SubscriptionProvider | null;
	updatedAt?: string;
	[key: string]: unknown;
}

export const QUOTA_MODES: readonly QuotaMode[] = ["auto", "codex", "claude", "both"];

export const QUOTA_MODE_INFO: Record<QuotaMode, string> = {
	auto: "Claude when a Claude model is active, Codex when a Codex model is active, otherwise the last subscription provider you selected",
	codex: "always show ChatGPT Codex quota",
	claude: "always show Claude subscription quota",
	both: "show Codex and Claude on one line (short format)",
};

export const DEFAULT_SETTINGS: QuotaSettings = {
	version: 1,
	mode: "auto",
	lastSubscriptionProvider: null,
};

/** Claude model provider ids, configurable to match custom Anthropic-compatible providers. */
export function claudeProviderIds(env: NodeJS.ProcessEnv = process.env): string[] {
	const raw = env.PI_QUOTA_CLAUDE_PROVIDERS ?? "anthropic,claude,github-copilot/claude";
	return raw.split(",").map((id) => id.trim()).filter(Boolean);
}

/** Codex model provider ids. */
export function codexProviderIds(env: NodeJS.ProcessEnv = process.env): string[] {
	const raw = env.PI_QUOTA_CODEX_PROVIDERS ?? "openai-codex,codex";
	return raw.split(",").map((id) => id.trim()).filter(Boolean);
}

export function providerKind(
	provider: string | undefined,
	claudeIds: readonly string[],
	codexIds: readonly string[],
): QuotaProvider | undefined {
	if (!provider) return undefined;
	if (claudeIds.includes(provider)) return "claude";
	if (codexIds.includes(provider)) return "codex";
	return undefined;
}

export function subscriptionForProvider(provider: QuotaProvider): SubscriptionProvider {
	return provider === "claude" ? "anthropic" : "openai-codex";
}

export function providerForSubscription(subscription: SubscriptionProvider | null | undefined): QuotaProvider | undefined {
	if (subscription === "anthropic") return "claude";
	if (subscription === "openai-codex") return "codex";
	return undefined;
}

/** Scopes that identify an OAuth login able to read Claude usage data. */
export function claudeAuthScopes(env: NodeJS.ProcessEnv = process.env): string[] {
	const raw = env.PI_QUOTA_CLAUDE_SCOPES ?? "user:profile user:inference user:sessions:claude_code user:mcp_servers";
	return raw.split(/\s+/).map((scope) => scope.trim()).filter(Boolean);
}

export interface CredentialProbe {
	(provider: string): unknown;
}

/**
 * Classify stored credentials without logging anything: OAuth logins are only
 * usable for quota reads when the granted scopes are known to include one of
 * the Claude usage scopes. API keys carry no subscription usage.
 */
export function detectCredentialKinds(
	probe: CredentialProbe,
	scopes: readonly string[] = claudeAuthScopes(),
): { claude: CredentialKind; codex: CredentialKind } {
	const kindOf = (provider: string): CredentialKind => {
		const raw = probe(provider);
		if (!raw || typeof raw !== "object") return "none";
		const record = raw as Record<string, unknown>;
		if (record.type === "api_key" || typeof record.key === "string") return "api-key";
		if (record.type !== "oauth" || typeof record.access !== "string") return "none";
		return "usable";
	};
	const kindOfClaude = (): CredentialKind => {
		const base = kindOf("anthropic");
		if (base !== "usable") return base;
		const record = probe("anthropic") as Record<string, unknown>;
		const granted = Array.isArray(record.scopes)
			? record.scopes.filter((scope): scope is string => typeof scope === "string")
			: typeof record.scopes === "string"
				? record.scopes.split(/\s+/)
				: undefined;
		// Older stored logins may omit the scope list; treat that as usable.
		if (!granted || !granted.length) return "usable";
		return granted.some((scope) => scopes.includes(scope)) ? "usable" : "oauth-no-usage";
	};
	return { claude: kindOfClaude(), codex: kindOf("openai-codex") };
}

export function isQuotaMode(value: unknown): value is QuotaMode {
	return typeof value === "string" && (QUOTA_MODES as readonly string[]).includes(value);
}

export function normalizeSettings(raw: unknown): QuotaSettings {
	const settings: QuotaSettings = { ...DEFAULT_SETTINGS };
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		const record = raw as Record<string, unknown>;
		if (isQuotaMode(record.mode)) settings.mode = record.mode;
		if (record.lastSubscriptionProvider === "anthropic" || record.lastSubscriptionProvider === "openai-codex") {
			settings.lastSubscriptionProvider = record.lastSubscriptionProvider;
		}
		if (typeof record.updatedAt === "string") settings.updatedAt = record.updatedAt;
		// Keep unknown keys (forward compatibility with other writers).
		for (const [key, value] of Object.entries(record)) {
			if (!(key in settings)) settings[key] = value;
		}
	}
	return settings;
}

export interface SettingsStore {
	readonly path: string;
	/** Reads the file, returns defaults when missing/invalid, never throws. */
	read(): QuotaSettings;
	/** Merges a patch and writes atomically; returns the new settings. */
	write(patch: Partial<QuotaSettings>): QuotaSettings;
	/** Last read/write problem (no credentials in it), for diagnostics. */
	readonly lastError?: string;
}

export function createSettingsStore(dir: string, fileName = QUOTA_SETTINGS_FILE): SettingsStore {
	const path = join(dir, fileName);
	let lastError: string | undefined;

	const read = (): QuotaSettings => {
		try {
			const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
			lastError = undefined;
			return normalizeSettings(raw);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			lastError = code === "ENOENT" ? undefined : `read failed: ${code ?? (error as Error).message}`;
			return { ...DEFAULT_SETTINGS };
		}
	};

	const write = (patch: Partial<QuotaSettings>): QuotaSettings => {
		const merged = { ...read(), ...patch, version: 1 as const, updatedAt: new Date().toISOString() };
		const settings = normalizeSettings(merged);
		try {
			mkdirSync(dirname(path), { recursive: true });
			const temp = `${path}.tmp`;
			writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
			renameSync(temp, path);
			lastError = undefined;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			lastError = `write failed: ${code ?? (error as Error).message}`;
		}
		return settings;
	};

	return {
		path,
		get lastError() {
			return lastError;
		},
		read,
		write,
	};
}

export interface ResolveTargetsInput {
	mode: QuotaMode;
	/** Provider id of the currently active model, if any. */
	activeProvider?: string;
	lastSubscriptionProvider?: SubscriptionProvider | null;
	credentialKinds?: { claude: CredentialKind; codex: CredentialKind };
	claudeIds?: readonly string[];
	codexIds?: readonly string[];
}

export interface ResolvedTargets {
	targets: QuotaProvider[];
	/** True when "auto" fell back to the last subscription provider (local model in use). */
	inherited: boolean;
	/** Human-readable explanation for the detailed view. */
	reason: string;
}

/**
 * Decide which subscription accounts to poll for the current model.
 *
 * "auto" never shows the wrong account: it keys off the active model's provider
 * id, so local/OSS models (unknown ids) keep the subscription provider that was
 * selected last.
 */
export function resolveTargets(input: ResolveTargetsInput): ResolvedTargets {
	const { mode } = input;
	const claudeIds = input.claudeIds ?? claudeProviderIds();
	const codexIds = input.codexIds ?? codexProviderIds();

	if (mode === "codex") return { targets: ["codex"], inherited: false, reason: "mode=codex" };
	if (mode === "claude") return { targets: ["claude"], inherited: false, reason: "mode=claude" };
	if (mode === "both") return { targets: ["codex", "claude"], inherited: false, reason: "mode=both" };

	const active = providerKind(input.activeProvider, claudeIds, codexIds);
	if (active) {
		return { targets: [active], inherited: false, reason: `active model provider ${input.activeProvider}` };
	}

	const inherited = providerForSubscription(input.lastSubscriptionProvider);
	if (inherited) {
		return {
			targets: [inherited],
			inherited: true,
			reason: `no subscription model active (provider: ${input.activeProvider ?? "none"}); showing last subscription provider ${input.lastSubscriptionProvider}`,
		};
	}

	const kinds = input.credentialKinds;
	const claudePresent = kinds ? kinds.claude !== "none" && kinds.claude !== "api-key" : false;
	const codexPresent = kinds?.codex === "usable";
	if (claudePresent && !codexPresent) {
		return { targets: ["claude"], inherited: false, reason: "only a Claude subscription login was found" };
	}
	if (codexPresent && !claudePresent) {
		return { targets: ["codex"], inherited: false, reason: "only a Codex subscription login was found" };
	}

	return { targets: ["codex"], inherited: false, reason: "no subscription provider detected, defaulting to Codex (change with /quota-provider)" };
}
