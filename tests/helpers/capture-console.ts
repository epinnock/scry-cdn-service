import { vi } from 'vitest';

/** Spy on every console method; `text()` returns everything logged, serialized. */
export function captureConsole() {
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const spies = methods.map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
  return {
    text: () =>
      spies
        .flatMap((s) => s.mock.calls)
        .map((args) =>
          args
            .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
            .join(' '),
        )
        .join('\n'),
    restore: () => spies.forEach((s) => s.mockRestore()),
  };
}
