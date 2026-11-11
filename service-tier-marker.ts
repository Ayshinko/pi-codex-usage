export interface FastTierStatus {
  provider: string;
  modelId: string;
  fast: boolean;
}

export function hasActiveFastTierMarker(
  model: { provider?: string; id?: string } | undefined,
  status: FastTierStatus | undefined,
): boolean {
  return Boolean(
    model &&
      status?.fast === true &&
      status.provider === model.provider &&
      status.modelId === model.id,
  );
}

export function getFastTierMarker(
  model: { provider?: string; id?: string } | undefined,
  status: FastTierStatus | undefined,
): string {
  return hasActiveFastTierMarker(model, status) ? "⚡" : "";
}
