import { createInterface } from 'node:readline';

export type PromptResult =
  | { status: 'answered'; answer: string }
  | { status: 'timeout' }
  | { status: 'closed' };

export type PromptIO = {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
};

export type PromptFn = (question: string, timeoutMs?: number) => Promise<PromptResult>;

/** Answers arriving faster than this after a prompt appears are treated as stale buffered input. */
export const STALE_ANSWER_WINDOW_MS = 150;

/**
 * Ask a question on the terminal. Resolves with the (trimmed, lower-cased) answer,
 * or with `timeout` / `closed` so callers never wait forever on an unattended terminal.
 *
 * Text typed after an earlier prompt timed out stays buffered in the terminal and would
 * otherwise be read as the answer to the *next* request. No human answers within a
 * fraction of a second, so such instant answers are discarded and the question is re-asked.
 */
export function promptWithTimeout(
  question: string,
  timeoutMs?: number,
  io: PromptIO = {},
  staleWindowMs: number = STALE_ANSWER_WINDOW_MS
): Promise<PromptResult> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;

  return new Promise((resolve) => {
    const rl = createInterface({ input, output });
    let done = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: PromptResult) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      rl.close();
      resolve(result);
    };

    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => {
        output.write('\n');
        finish({ status: 'timeout' });
      }, timeoutMs);
    }

    rl.on('close', () => finish({ status: 'closed' }));

    const ask = () => {
      const askedAt = Date.now();
      rl.question(question, (answer) => {
        if (!done && Date.now() - askedAt < staleWindowMs) {
          ask(); // stale buffered input, not a real answer
          return;
        }
        finish({ status: 'answered', answer: answer.trim().toLowerCase() });
      });
    };
    ask();
  });
}

/** Human-readable approval text. Code is shown as a block so it can actually be reviewed. */
export function formatApprovalSummary(details: Record<string, unknown>): string {
  const { code, ...rest } = details;
  let summary = JSON.stringify(rest, null, 2).replace(/"token"\s*:\s*"[^"]+"/gi, '"token":"[REDACTED]"');
  if (typeof code === 'string') {
    const shown = code.length > 4000 ? `${code.slice(0, 4000)}\n... (${code.length - 4000} more characters)` : code;
    summary += `\n----- code -----\n${shown}\n----------------`;
  }
  return summary;
}

/** Serialises terminal prompts: concurrent tool calls must not fight over one stdin. */
let approvalQueue: Promise<unknown> = Promise.resolve();
export function enqueueApproval<T>(task: () => Promise<T>): Promise<T> {
  const run = approvalQueue.then(task, task);
  approvalQueue = run.catch(() => undefined);
  return run;
}
