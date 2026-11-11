import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";

export interface OutputTiming {
  requestStartedAt: number;
  firstTokenAt?: number;
  lastOutputAt?: number;
  streamedContentIndexes: Set<number>;
  fullyRecordedContentIndexes: Set<number>;
}

export interface RecentOutputMetrics {
  ttftMs: number;
  tokensPerSecond?: number;
}

export function createOutputTiming(requestStartedAt: number): OutputTiming {
  return {
    requestStartedAt,
    streamedContentIndexes: new Set(),
    fullyRecordedContentIndexes: new Set(),
  };
}

/** Observe the first reasoning event, then visible text/tool-call output as fallback. */
export function observeOutputEvent(
  timing: OutputTiming,
  event: AssistantMessageEvent,
  message: AssistantMessage,
  now: number,
): boolean {
  let firstTokenIsAvailable = false;
  let outputWasObserved = false;

  switch (event.type) {
    case "thinking_delta":
    case "text_delta":
    case "toolcall_delta":
      if (event.delta.length > 0) {
        timing.streamedContentIndexes.add(event.contentIndex);
        firstTokenIsAvailable = true;
        outputWasObserved = true;
      }
      break;
    case "text_end":
    case "thinking_end":
      if (event.content.length > 0) {
        if (
          !timing.streamedContentIndexes.has(event.contentIndex) &&
          !timing.fullyRecordedContentIndexes.has(event.contentIndex)
        ) {
          timing.fullyRecordedContentIndexes.add(event.contentIndex);
          outputWasObserved = true;
        }
        // A late reasoning summary is not reliable TTFT; text_end is the visible fallback.
        firstTokenIsAvailable = event.type === "text_end";
      }
      break;
    case "thinking_start": {
      // Redacted thinking may be delivered complete at block start without deltas.
      const block = message.content[event.contentIndex];
      if (block?.type === "thinking" && block.thinking.length > 0) {
        timing.fullyRecordedContentIndexes.add(event.contentIndex);
        firstTokenIsAvailable = true;
        outputWasObserved = true;
      }
      break;
    }
    case "toolcall_start":
      firstTokenIsAvailable = true;
      outputWasObserved = true;
      break;
  }

  if (outputWasObserved) timing.lastOutputAt = now;
  if (firstTokenIsAvailable && timing.firstTokenAt === undefined) {
    timing.firstTokenAt = now;
    return true;
  }
  return false;
}

export function firstTokenMetrics(timing: OutputTiming): RecentOutputMetrics | null {
  if (timing.firstTokenAt === undefined) return null;
  return { ttftMs: Math.max(0, timing.firstTokenAt - timing.requestStartedAt) };
}

export function retainPreviousTokenRate(
  metrics: RecentOutputMetrics,
  previous: RecentOutputMetrics | null,
): RecentOutputMetrics {
  return {
    ...metrics,
    tokensPerSecond: metrics.tokensPerSecond ?? previous?.tokensPerSecond,
  };
}

/** Use provider-reported output tokens and only the observed streaming interval. */
export function completeOutputTiming(
  timing: OutputTiming,
  outputTokens?: number,
): RecentOutputMetrics | null {
  const firstTokenAt = timing.firstTokenAt;
  if (firstTokenAt === undefined) return null;
  const generationMs = (timing.lastOutputAt ?? firstTokenAt) - firstTokenAt;
  const hasActualTokenCount = typeof outputTokens === "number" && Number.isFinite(outputTokens) && outputTokens > 0;
  return {
    ttftMs: Math.max(0, firstTokenAt - timing.requestStartedAt),
    tokensPerSecond:
      hasActualTokenCount && generationMs > 0 ? outputTokens * 1000 / generationMs : undefined,
  };
}

export function formatSeconds(milliseconds: number): string {
  const seconds = Math.max(0, milliseconds) / 1000;
  return `${seconds < 10 ? seconds.toFixed(2) : seconds.toFixed(1)}s`;
}

export function formatRecentOutput(metrics: RecentOutputMetrics): string {
  const rateText = metrics.tokensPerSecond === undefined
    ? ""
    : ` ${metrics.tokensPerSecond < 10 ? metrics.tokensPerSecond.toFixed(1) : Math.round(metrics.tokensPerSecond)}t/s`;
  return `${formatSeconds(metrics.ttftMs)}${rateText}`;
}
