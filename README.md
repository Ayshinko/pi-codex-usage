# Codex + Claude subscription quotas

Read-only quota status in the Pi footer for **ChatGPT Codex** (`openai-codex`) and **Claude Pro/Max** (`anthropic`) subscriptions. The extension reuses the logins Pi already has, never writes credentials, and degrades to `N/A` instead of guessing when a value is unavailable.

## Footer

Long format (one provider, the default for `auto`/`codex`/`claude`):

```
Codex 5h 73% left · W 81% left
Claude 5h 82% left · W 53% left · Opus N/A · Sonnet 60% left
```

Short format (`both` mode, single line):

```
Codex 5h 73% · W 81% | Claude 5h 82% · W 53%
```

Color is theme-driven: `>80%` remaining green, `50–80%` dim, `20–50%` yellow, `<20%` red. Stale data keeps the last successful numbers and adds an `(!)` marker with its age; the detailed report states the age and the reason for the failure.

## Commands

| Command | What it does |
| --- | --- |
| `/quota` | Detailed report for the current mode: 5h and weekly usage, resets with absolute times, per-model limits, credit balance, data source and age |
| `/quota-provider [auto\|codex\|claude\|both\|status]` | Show or change which subscription is polled, and therefore shown in the footer |
| `/claude-quota` | Claude detail (N/A plus a `/login` hint when the login is missing or lacks quota scopes) |
| `/codex-quota` | Codex detail, in the pre-upgrade text format |

No command reads, prints, or stores tokens.

## Modes

| Mode | Polls and shows |
| --- | --- |
| `auto` (default) | Codex only when the active model's provider is a Codex provider, Claude only when it is an Anthropic provider; other providers inherit the last subscription seen, otherwise the credential that exists (`N/A` when neither exists) |
| `codex` | Codex only, regardless of the active model |
| `claude` | Claude only, regardless of the active model |
| `both` | Both, joined on one footer line in the short format |

Provider IDs that count as Codex/Claude subscriptions are configurable:

```bash
PI_QUOTA_CODEX_PROVIDERS=openai-codex,codex
PI_QUOTA_CLAUDE_PROVIDERS=anthropic,claude,github-copilot/claude
```

Settings live in `<agent directory>/quota-usage.json` (`mode`, `lastSubscriptionProvider`, plus a version field). Credential material is never written there — only non-secret mode and provider names.

## Data sources

| Provider | Source | Notes |
| --- | --- | --- |
| Codex | `GET https://chatgpt.com/backend-api/wham/usage` | Windows are classified by `limit_window_seconds` (≤6 h → 5h, longer → weekly) instead of the `primary`/`secondary` field names, because OpenAI assigns those per plan. Undocumented endpoint. |
| Claude | `GET https://api.anthropic.com/api/oauth/usage` with `anthropic-beta: oauth-2025-04-20,claude-code-20250219` | Percent windows (`remaining`, `resets_at` as ISO or epoch), `usage_percentage` fractional values (0.45 → 45%), `six_hour_resets_at` for the weekly window, per-model limits (`claude_opus`, `claudeSonnet`, OAuth apps), and `additional_rates` (`overloaded` / `credit` / `pro_low`…) |
| Claude fallback | Response headers `anthropic-ratelimit-unified-5h-utilization` and `…week-utilization` | Every provider response is inspected passively (no extra request). Header data is merged into the cached snapshot at field level and marked `source: headers`; it is still subject to the 60-second cache and refreshes. |

The Claude usage endpoint is undocumented and may change without notice. A login that only has API-key billing, or a login without the quota scopes, has no usage endpoint — the footer then shows `N/A` and `/login` guidance instead of inventing numbers.

## Credentials and caching

- Tokens are read from Pi's credential store (`auth.json`) through Pi's own reader at request time. Nothing is written, rotated, or copied: no `chmod`/file mutation, and no `~/.codex` involvement.
- Missing, expired, or API-key-only credentials are detected locally before any request, so the footer says `N/A` and `/login` without a network call. HTTP 401/403 are treated as expired logins.
- A 60-second cache is shared by all triggers (session start, model select, turn end, the 60-second timer, and commands), with a minimum 30-second re-fetch after a failure. Successful fetches are cached until the next trigger; concurrent refreshes are serialized rather than dropped.
- On failure the last successful values stay visible with an age marker; `backoff`, `unauthorized`, `not-provisioned`, `no-credentials`, `no-usage-data`, `timeout`, `parse`, `http`, and `other` codes drive the detailed report.

## Development

```bash
npm install          # dev-only dependencies (typescript, @types/node)
npm run check        # tsc --noEmit with tsconfig.dev.json
npm test             # node --experimental-strip-types test.mjs (21 tests, no network)
npm run live         # real quota endpoints, prints each footer mode; needs your logins
```

`tsconfig.dev.json` exists only for the type check: Pi loads the extension through jiti and does not read it.

## Files

| File | Role |
| --- | --- |
| `index.ts` | Extension entry: commands, events, mode resolution, timer, footer rendering |
| `codex-usage.ts` | Codex client + the byte-compatible pre-upgrade text format |
| `claude-usage.ts` | Claude client: endpoint, header ingestion, payload normalization, error codes |
| `quota-model.ts` | Shared snapshot/window types and formatting helpers |
| `quota-settings.ts` | Settings store, provider ID lists, mode resolution, credential-kind detection |
| `quota-display.ts` | Footer and detail rendering, theme color painter with nesting |
| `test.mjs`, `live-check.mjs` | Tests and the manual live check |
| `index.ts.bak-20261108` | Backup of the Codex-only entry point before the upgrade |

`codex-context-window.ts`, `output-metrics.ts`, and `service-tier-marker.ts` are unrelated files from an upstream fork; the `pi.extensions` manifest lists only `index.ts`, so they are not loaded by this extension. Pi's own footer already renders model, context window, token, and speed counters — this extension contributes only the quota segment.

The npm packages `pi-quota` and `pi-usage` were considered and rejected: both are unmaintained, and neither supports mode switching with per-provider polling plus the passive header fallback.
