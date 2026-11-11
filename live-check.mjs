/**
 * Live check against the real subscription accounts (needs the user's own
 * logins; run manually with: npm run live)
 *
 * Reads credentials from $PI_CODING_AGENT_DIR/auth.json, asks both quota
 * endpoints for data, prints every footer mode the way the extension renders it,
 * and verifies that the displayed numbers are the provider's numbers (never
 * invented). Nothing is written and no secret is ever printed.
 */

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

import { compactStatus, createQuotaClient, detailed } from "./codex-usage.ts";
import { createClaudeQuotaClient } from "./claude-usage.ts";
import { formatDetailedReport, formatStatusLine } from "./quota-display.ts";
import { resolveTargets } from "./quota-settings.ts";

const agentDir = process.env.PI_CODING_AGENT_DIR ?? `${process.env.HOME ?? process.env.USERPROFILE}/.pi/agent`;
const mark = (token, text) => `[${token}]${text}`;

function storedCredential(provider) {
	try {
		const auth = JSON.parse(readFileSync(`${agentDir}/auth.json`, "utf8"));
		const stored = auth?.[provider];
		return typeof stored === "string" ? JSON.parse(stored) : stored;
	} catch {
		return undefined;
	}
}

function describeCredential(raw) {
	if (!raw) return "none";
	if (raw.type === "api_key" || typeof raw.key === "string") return "api-key";
	if (raw.type === "oauth") return `oauth${Array.isArray(raw.scopes) ? ` (with ${raw.scopes.length} scopes)` : ""}`;
	return raw.type ?? "unknown";
}

console.log(`agent dir: ${agentDir}`);
console.log(`anthropic credential:    ${describeCredential(storedCredential("anthropic"))}`);
console.log(`openai-codex credential: ${describeCredential(storedCredential("openai-codex"))}`);

const claudeClient = createClaudeQuotaClient({ readCredential: storedCredential, fetcher: fetch });
const codexClient = createQuotaClient(storedCredential, fetch);

async function attempt(label, task) {
	try {
		return { ok: true, snapshot: await task() };
	} catch (error) {
		console.log(`${label}: unavailable — ${error.message}`);
		return { ok: false, error };
	}
}

const claudeResult = await attempt("claude", () => claudeClient.getQuota(true));
const codexResult = await attempt("codex", () => codexClient.fetchUsage(true));

const fallback = (provider, result) => {
	const message = result.error?.message ?? "";
	const known = message.startsWith(`${provider}: `);
	return known ? message : `${provider === "codex" ? "Codex" : "Claude"}: N/A`;
};
const entries = [
	{ provider: "codex", result: codexResult },
	{ provider: "claude", result: claudeResult },
].map(({ provider, result }) =>
	result.ok
		? { provider, snapshot: result.snapshot, fallback: `${provider === "codex" ? "Codex" : "Claude"}: N/A` }
		: { provider, fallback: fallback(provider, result), error: { code: result.error?.code ?? "other", message: result.error?.message ?? "unknown" } },
);

for (const mode of ["auto", "codex", "claude", "both"]) {
	const targets = resolveTargets({ mode, activeProvider: "anthropic", lastSubscriptionProvider: "openai-codex" });
	const selected = entries.filter((entry) => targets.targets.includes(entry.provider));
	console.log(`\n[${mode.padEnd(5)}] targets: ${targets.targets.join(",")} — ${targets.reason}`);
	console.log(`  footer: ${formatStatusLine(selected, { short: selected.length > 1, paint: mark })}`);
}

console.log(`\n--- detailed report ---\n${formatDetailedReport(entries, { mode: "both", reason: "live check" })}`);

const footer = formatStatusLine(entries, { short: entries.length > 1 });
assert.doesNotMatch(footer, /sk-[A-Za-z0-9]|Bearer|refresh|token/i, "the footer must not contain credentials");
for (const entry of entries) {
	const snapshot = entry.snapshot;
	if (!snapshot) continue;
	const windows = [["fiveHour", snapshot.fiveHour], ["weekly", snapshot.weekly], ...(snapshot.models ?? []).map((model) => [model.key, model.window])];
	for (const [name, window] of windows) {
		if (!window) continue;
		assert.equal(typeof window.used, "number", `${name}.used must be a number (got ${typeof window.used})`);
		assert.ok(window.used >= 0 && window.used <= 100, `${name}.used out of range: ${window.used}`);
		if (name === "fiveHour" || name === "weekly") {
			const shown = `${Math.round(100 - window.used)}%`;
			assert.ok(footer.includes(shown), `footer is missing the ${name} value ${shown}: ${footer}`);
		}
	}
	if (snapshot.credits) assert.equal(typeof snapshot.credits.enabled, "boolean", "credits.enabled must be a boolean");
}

if (codexResult.snapshot) {
	const legacy = compactStatus(codexResult.snapshot);
	assert.match(legacy, /^Codex 5h \d+% left · W \d+% left$/, `unexpected legacy footer: ${legacy}`);
	console.log(`\ncodex legacy footer: ${legacy}`);
	console.log(`codex detail line 2: ${detailed(codexResult.snapshot).split("\n")[1]}`);
}
if (claudeResult.snapshot) console.log(`\nclaude data source: ${claudeResult.snapshot.source}`);

console.log("\nlive check OK");
