import type { CordisContext } from '@dsh-plugin/dsh-loader';
import { retryDelayMs, sleep } from './retry.js';

interface RequestError {
  turn: number;
  step: number;
  signal: AbortSignal;
  failure: { code: string; message: string };
}

type RequestErrorAction = { kind: 'retry' } | undefined;

function isStreamReadError({ code, message }: RequestError['failure']): boolean {
  if (code !== 'PI_AI_ERROR' || !message.trimStart().startsWith('{')) {
    return false;
  }

  let event: { type?: unknown; error?: { type?: unknown } } | null;
  try {
    event = JSON.parse(message);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return false;
    }
    throw error;
  }
  return event?.type === 'error' && event.error?.type === 'stream_read_error';
}

/** 在 DSH 已结算失败的响应流后重试当前模型步骤。 */
export function installStreamRetry(ctx: CordisContext, getMaxRetries: () => number): void {
  ctx.effect(() => {
    const lifetime = new AbortController();
    const retries = new WeakMap<AbortSignal, { turn: number; step: number; attempt: number }>();
    const unhook = ctx.on?.('agent/request-error', async (
      { turn, step, signal, failure }: RequestError,
      next: () => Promise<RequestErrorAction>,
    ): Promise<RequestErrorAction> => {
      const action = await next();
      if (action || !isStreamReadError(failure) || signal.aborted || lifetime.signal.aborted) {
        return action;
      }

      const maxRetries = getMaxRetries();
      const previous = retries.get(signal);
      const attempt = previous?.turn === turn && previous.step === step ? previous.attempt + 1 : 1;
      if (attempt > maxRetries) {
        return;
      }

      const retrySignal = AbortSignal.any([signal, lifetime.signal]);
      const delayMs = retryDelayMs(attempt);
      ctx.logger?.info?.(`[dsh-network-settings] 自动重试模型请求 ${attempt}/${maxRetries}（stream_read_error），${Math.round(delayMs)}ms 后重发`);
      try {
        await sleep(delayMs, retrySignal);
      } catch (error) {
        if (!retrySignal.aborted) {
          throw error;
        }
      }
      if (retrySignal.aborted || attempt > getMaxRetries()) {
        return;
      }

      retries.set(signal, { turn, step, attempt });
      return { kind: 'retry' };
    });

    return () => {
      unhook?.();
      lifetime.abort();
    };
  }, 'dsh-network-settings: model stream retry');
}
