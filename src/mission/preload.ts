/**
 * Resolves when every promise in `promises` has settled (fulfilled or rejected), or after `timeoutMs`, whichever comes first.
 * Never rejects and never leaves its timer running. The mission start uses it to wait for the glTF models (vegetation, nest
 * rocks) while "Preparing mission…" is up, so they are in the first frame; a slow or missing file does not hold the start up.
 */
export function settledWithin(promises: ReadonlyArray<Promise<unknown>>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    void Promise.allSettled(promises).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
