/**
 * Shared data model for subscription quota display (ChatGPT Codex + Claude Pro/Max).
 *
 * Percentages are always taken verbatim from the provider payload. When a
 * provider does not report a window, the window stays `undefined` and the
 * display layer renders `N/A` rather than inventing a number.
 */

export type QuotaProvider = "codex" | "claude";
export type QuotaMode = "auto" | "codex" | "claude" | "both";

export interface QuotaWindow {
	/** Percent used (0..100), exactly as reported by the provider. */
	used: number;
	/** Reset time in epoch milliseconds; 0 when the provider did not report one. */
	resetAt: number;
}

export interface ModelQuotaWindow {
	key: "opus" | "sonnet" | "oauth-apps";
	label: string;
	window?: QuotaWindow;
}

export interface ClaudeCredits {
	enabled: boolean;
	disabledReason?: string | null;
	spendLimitReached?: boolean;
}

/** One row of Claude's `limits` array (severity/is_active state for a window). */
export interface ClaudeLimitRow {
	kind: string;
	limit: string;
	percent: number;
	severity: string;
	isActive: boolean;
}

export interface QuotaSnapshot {
	provider: QuotaProvider;
	fetchedAt: number;
	/** Where the numbers came from: usage endpoint, response headers, or both. */
	source: "endpoint" | "headers" | "mixed";
	fiveHour?: QuotaWindow;
	weekly?: QuotaWindow;
	/** Claude only: per-model weekly limits (Opus / Sonnet / OAuth apps). */
	models?: ModelQuotaWindow[];
	/** Codex only. */
	plan?: string;
	/** Codex: `codex_spend_reasons`; Claude: limit rows with a non-normal severity. */
	limitReached?: boolean;
	/** Claude only: paid usage credits. */
	credits?: ClaudeCredits;
	/** Claude only: `seven_day_breakdown` rows (Claude Code / Chats / Cowork / Other). */
	breakdown?: { key: string; label: string; percent: number }[];
	/** Claude only: `limits[]` rows with non-normal severity (warning state). */
	limitRows?: ClaudeLimitRow[];
}

export const PROVIDER_LABELS: Record<QuotaProvider, string> = {
	codex: "Codex",
	claude: "Claude",
};

export function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

/** Build a window from already-normalized inputs; undefined when unusable. */
export function toQuotaWindow(usedPercent: unknown, resetAtMs: unknown): QuotaWindow | undefined {
	if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return undefined;
	const resetAt = typeof resetAtMs === "number" && Number.isFinite(resetAtMs) && resetAtMs > 0 ? Math.round(resetAtMs) : 0;
	return { used: clampPercent(usedPercent), resetAt };
}

/** Remaining percent as an integer; undefined means unknown (never 0). */
export function remainingPercent(window?: QuotaWindow): number | undefined {
	return window ? Math.round(100 - clampPercent(window.used)) : undefined;
}

/**
 * Footer remaining text, integer rounded like the legacy `compactStatus`.
 * "95%" when known, "N/A" when the provider did not report the window.
 */
export function remainingText(window?: QuotaWindow): string {
	return window ? `${Math.round(100 - clampPercent(window.used))}%` : "N/A";
}

/** Used percent with one decimal, for the detailed view ("45.0%"). */
export function usedText(window?: QuotaWindow): string {
	return window ? `${clampPercent(window.used).toFixed(1)}%` : "N/A";
}

/**
 * Legacy-compatible text: "unknown" | "5m" | "2h 10m" | "3d 4h".
 * Kept byte-identical to the original `codex-usage` implementation.
 */
export function resetText(resetAtMs: number, now: number = Date.now()): string {
	if (!resetAtMs) return "unknown";
	const mins = Math.max(0, Math.ceil((resetAtMs - now) / 60_000));
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	return hours < 24 ? `${hours}h ${mins % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Short age text for cache markers: "12s" / "6m" / "2h". */
export function ageText(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h`;
}

/** Absolute reset timestamp, e.g. "2026-11-12T20:00 UTC". */
export function formatAbsolute(resetAtMs: number): string {
	if (!resetAtMs) return "unknown";
	const date = new Date(resetAtMs);
	if (Number.isNaN(date.getTime())) return "unknown";
	return `${date.toISOString().slice(0, 16)} UTC`;
}

export type Paint = (token: string, text: string) => string;

/** No-op painter used when the extension runtime gives us no theme. */
export const noPaint: Paint = (_token, text) => text;
