/**
 * Footer and detail rendering for subscription quotas.
 *
 * Colors come from Pi's theme API. The painter nests one color level per
 * segment: the parent's color code is emitted before the child's reset, so the
 * following siblings stay on the parent's color instead of falling to default.
 */

import { ageText, clampPercent, formatAbsolute, PROVIDER_LABELS, remainingText, resetText, usedText } from "./quota-model.ts";
import type { Paint, QuotaProvider, QuotaSnapshot, QuotaWindow } from "./quota-model.ts";
import { QUOTA_MODE_INFO, type QuotaMode } from "./quota-settings.ts";
import { detailed as legacyCodexDetailed } from "./codex-usage.ts";

export type StatusToken = "dim" | "warning" | "error" | "accent";

interface Segment {
	/** Colored text (the label and its number share the status color). */
	text: string;
	/** Plain text appended to `text` before the next separator. */
	suffix: string;
	color: StatusToken;
}

export interface QuotaEntry {
	provider: QuotaProvider;
	snapshot?: QuotaSnapshot;
	/** Footer text when nothing can be shown, e.g. "Codex: N/A". */
	fallback: string;
	/** Set when the fetch failed; the message never contains credentials. */
	error?: { code: string; message: string };
	/** Snapshot age in milliseconds when it exceeds the stale threshold. */
	staleMs?: number;
}

export interface FormatOptions {
	/** Compact layout, used when both providers share one footer line. */
	short?: boolean;
	/** Paint from Pi's theme; plain text when omitted. */
	paint?: Paint;
}

export interface ReportContext {
	mode?: QuotaMode;
	/** Explanation from resolveTargets(), shown in the detailed view. */
	reason?: string;
	now?: number;
}

/**
 * Paints one span. `renderSegments` nests right-to-left, so each parent's color
 * code is emitted before the child's reset and following text never inherits
 * a child color.
 */
function painter(paint: Paint | undefined): (token: StatusToken, text: string) => string {
	if (!paint) return (_token, text) => text;
	return (token, text) => paint(token, text);
}

/** Join `head` + segments left-to-right, nesting one color level per segment. */
function renderSegments(paint: Paint | undefined, head: string, segments: Segment[], separator: string): string {
	const apply = painter(paint);
	return segments.reduceRight<string>((tail, segment, index) => {
		const own = `${index === 0 ? head : ""}${segment.text}${segment.suffix}`;
		return apply(segment.color, tail ? `${own}${separator}${tail}` : own);
	}, "");
}

function statusColor(used: number | undefined): StatusToken {
	if (used === undefined) return "dim";
	if (used >= 90) return "error";
	if (used >= 75) return "warning";
	return "dim";
}

/** `5h 95% left` (long) or `5h 95%` (short); unknown windows show bare `N/A` (exactly like the legacy line). */
function windowSegment(window: QuotaWindow | undefined, label: string, short: boolean): Segment {
	return { text: `${label} ${remainingText(window)}`, suffix: window && !short ? " left" : "", color: statusColor(window?.used) };
}

function modelSegments(snapshot: QuotaSnapshot, short: boolean): Segment[] {
	return (snapshot.models ?? [])
		// Unknown per-model limits: show Opus and Sonnet (the headline limits) and
		// hide the OAuth-apps line unless the provider reports data for it.
		.filter((model) => (short ? Boolean(model.window) : model.key !== "oauth-apps" || Boolean(model.window)))
		.map((model) => ({
			text: `${model.label} ${remainingText(model.window)}`,
			suffix: model.window && !short ? " left" : "",
			color: statusColor(model.window?.used),
		}));
}

function staleSegment(staleMs: number | undefined): Segment[] {
	return staleMs === undefined ? [] : [{ text: `stale ${ageText(staleMs)}`, suffix: "", color: "dim" }];
}

/** Codex segments render exactly like the legacy `compactStatus` in plain text. */
function segmentsFor(entry: QuotaEntry, short: boolean): Segment[] | undefined {
	const snapshot = entry.snapshot;
	if (!snapshot) return undefined;
	if (snapshot.limitReached) return [{ text: "Limit reached", suffix: "", color: "error" }];
	const windows: Segment[] =
		entry.provider === "codex"
			? [windowSegment(snapshot.fiveHour, "5h", short), windowSegment(snapshot.weekly, "W", short)]
			: [windowSegment(snapshot.fiveHour, "5h", short), windowSegment(snapshot.weekly, "W", short), ...modelSegments(snapshot, short)];
	if (!snapshot.fiveHour && !snapshot.weekly && !snapshot.models?.some((model) => model.window)) return undefined;
	return [...windows, ...staleSegment(entry.staleMs)];
}

/** One provider's footer text; the fallback is used when nothing can be shown. */
export function formatEntry(entry: QuotaEntry, options: FormatOptions = {}): string {
	const segments = segmentsFor(entry, Boolean(options.short));
	if (!segments) return entry.fallback;
	return renderSegments(options.paint, `${PROVIDER_LABELS[entry.provider]} `, segments, " · ");
}

/**
 * Whole footer status for the active targets.
 * `Claude 5h 97% left · W 55% left` or `Codex 5h 82% · W 63% | Claude 5h 97% · W 55%`.
 */
export function formatStatusLine(entries: QuotaEntry[], options: FormatOptions = {}): string {
	if (!entries.length) return "Codex: N/A";
	return entries.map((entry) => formatEntry(entry, options)).join(" | ");
}

function detailLine(label: string, window: QuotaWindow | undefined, now: number): string {
	const used = window ? `${clampPercent(window.used).toFixed(1)}% used · ${(100 - clampPercent(window.used)).toFixed(1)}% remaining` : "N/A";
	const reset = window?.resetAt ? `resets in ${resetText(window.resetAt, now)} (${formatAbsolute(window.resetAt)})` : "resets in unknown";
	return `${label}: ${used} · ${reset}`;
}

/** Claude detail lines (the Codex side reuses the legacy detail text verbatim). */
function claudeDetailLines(snapshot: QuotaSnapshot, now: number): string[] {
	const lines = [
		`Claude quota${snapshot.limitReached ? " — limit reached" : ""}`,
		detailLine("5-hour", snapshot.fiveHour, now),
		detailLine("weekly (all models)", snapshot.weekly, now),
	];
	for (const model of snapshot.models ?? []) lines.push(detailLine(`${model.label} weekly`, model.window, now));
	if (snapshot.breakdown?.length) lines.push(`weekly breakdown: ${snapshot.breakdown.map((row) => `${row.label} ${clampPercent(row.percent).toFixed(1)}%`).join(" · ")}`);
	const credits = snapshot.credits;
	if (credits) {
		const state = credits.enabled ? "available" : `disabled${credits.disabledReason ? ` (${credits.disabledReason})` : ""}`;
		lines.push(`usage credits: ${state}${credits.spendLimitReached ? " · spend limit reached" : ""}`);
	}
	lines.push(snapshot.limitRows?.length
		? `limit state: ${snapshot.limitRows.map((row) => `${row.limit} ${row.percent.toFixed(0)}% ${row.severity}${row.isActive ? " (active)" : ""}`).join(" · ")}`
		: "limit state: none");
	lines.push(`source: ${sourceText(snapshot)} · fetched ${ageText(Math.max(0, now - snapshot.fetchedAt))} ago`);
	return lines;
}

function sourceText(snapshot: QuotaSnapshot): string {
	return snapshot.source === "headers" ? "response headers" : snapshot.source === "mixed" ? "usage endpoint + response headers" : "usage endpoint";
}

function codexDetailLines(snapshot: QuotaSnapshot, now: number): string[] {
	// Skip the legacy "Codex quota" header, keep its wording byte-for-byte.
	const lines = legacyCodexDetailed(snapshot, now).split("\n").slice(1);
	lines.push(`source: ${sourceText(snapshot)} · fetched ${ageText(Math.max(0, now - snapshot.fetchedAt))} ago`);
	return lines;
}

function helpLines(entry: QuotaEntry): string[] {
	const code = entry.error?.code ?? "";
	const account = entry.provider === "claude" ? "anthropic" : "openai-codex";
	if (code === "auth-unavailable") return [`hint: run /login and choose ${account}, or pick a ${PROVIDER_LABELS[entry.provider]} model to start a session with that account`];
	if (code === "auth-expired") return ["hint: send one request with this provider to refresh the login, or run /login"];
	if (code === "api-key-auth") return ["hint: an API key is configured; subscription usage needs OAuth — run /login and choose anthropic"];
	if (code === "oauth-no-usage") return ["hint: this Claude login lacks the usage scopes — log out and back in with /login anthropic to read usage"];
	if (entry.snapshot) return ["hint: showing the last successful read; refreshes automatically"];
	if (code === "backoff" || code === "network" || code === "timeout" || code === "unavailable") return ["hint: temporarily unavailable; retrying on the next refresh"];
	return [];
}

/** Full report for /quota and /claude-quota; the legacy /codex-quota text stays separate. */
export function formatDetailedReport(entries: QuotaEntry[], context: ReportContext = {}): string {
	const now = context.now ?? Date.now();
	const sections = entries.map((entry) => {
		if (!entry.snapshot) {
			const reason = entry.error?.message ?? entry.fallback;
			return [`${PROVIDER_LABELS[entry.provider]} quota unavailable: ${reason}`, ...helpLines(entry)];
		}
		const lines = entry.provider === "codex" ? [`Codex quota`, ...codexDetailLines(entry.snapshot, now)] : claudeDetailLines(entry.snapshot, now);
		if (entry.staleMs !== undefined) lines.unshift(`(stale ${ageText(entry.staleMs)} — last successful read)`);
		if (entry.error) lines.push(...helpLines(entry));
		return lines;
	});
	const report = sections.map((section) => section.join("\n")).filter((text) => text.length > 0).join("\n\n");
	if (!context.mode) return report;
	return `${report}\n\nMode: ${context.mode} (${QUOTA_MODE_INFO[context.mode]})${context.reason ? ` — ${context.reason}` : ""}`;
}

/** Re-export of the legacy Codex detail text, used by /codex-quota for exact compatibility. */
export function legacyCodexDetail(entry: QuotaEntry, now: number = Date.now()): string | undefined {
	return entry.snapshot ? legacyCodexDetailed(entry.snapshot, now) : undefined;
}

/** Footer-compatible single line summary used by notifications. */
export function summaryLine(entries: QuotaEntry[], options: FormatOptions = {}): string {
	return formatStatusLine(entries, options);
}
