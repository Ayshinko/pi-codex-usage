export const CODEX_GPT_CONTEXT_WINDOW = 512_000;

// Exact model rules take precedence over the family-wide default below.
export const CODEX_GPT_CONTEXT_OVERRIDES: Readonly<Record<string, number>> = {
  "gpt-5.6-luna": 1_000_000,
  "gpt-5.6-terra": 1_000_000,
  "gpt-6-luna": 1_000_000,
};

export function getCodexGptContextWindow(
  model: { provider?: unknown; id?: unknown },
  overrides: Readonly<Record<string, number>> = CODEX_GPT_CONTEXT_OVERRIDES,
): number | undefined {
  if (
    model.provider !== "openai-codex" ||
    typeof model.id !== "string"
  ) {
    return undefined;
  }

  if (Object.hasOwn(overrides, model.id)) return overrides[model.id];

  const version = /^gpt-(\d+)(?:\.(\d+))?(?=$|[-.])/i.exec(model.id);
  if (!version) return undefined;

  const major = Number(version[1]);
  const minor = Number(version[2] ?? 0);
  const isAtLeastGpt56 = major > 5 || (major === 5 && minor >= 6);
  return isAtLeastGpt56 ? CODEX_GPT_CONTEXT_WINDOW : undefined;
}
