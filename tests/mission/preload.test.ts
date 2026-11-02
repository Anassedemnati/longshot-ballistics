import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settledWithin } from '../../src/mission/preload';

describe('settledWithin', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves once everything has settled, rejections included, and leaves no timer running', async () => {
    let done = false;
    const slow = new Promise<void>((resolve) => setTimeout(resolve, 100));
    const failing = Promise.reject(new Error('no file'));
    const p = settledWithin([slow, failing], 5000).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(50);
    expect(done).toBe(false); // the slow one is still loading
    await vi.advanceTimersByTimeAsync(60);
    await p;
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up after the timeout when a promise never settles', async () => {
    let done = false;
    const p = settledWithin([new Promise(() => undefined)], 800).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(799);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await p;
    expect(done).toBe(true);
  });

  it('with nothing to wait for it resolves at once', async () => {
    await settledWithin([], 1000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
