import { useEffect, useState } from 'react';
import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDebouncedValue } from '../hooks/useDebouncedValue';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('manual filter debounce', () => {
  it('exposes the initial value immediately and only the final rapid selection after 200 ms', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value), { initialProps: { value: 'A' } });
    expect(result.current).toBe('A');
    rerender({ value: 'B' });
    act(() => vi.advanceTimersByTime(100));
    rerender({ value: 'C' });
    act(() => vi.advanceTimersByTime(199));
    expect(result.current).toBe('A');
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe('C');
  });

  it('clears replaced, reverted and unmounted timers', () => {
    const { rerender, unmount } = renderHook(({ value }) => useDebouncedValue(value), { initialProps: { value: 2019 } });
    rerender({ value: 2020 });
    expect(vi.getTimerCount()).toBe(1);
    rerender({ value: 2021 });
    expect(vi.getTimerCount()).toBe(1);
    rerender({ value: 2019 });
    expect(vi.getTimerCount()).toBe(0);
    rerender({ value: 2021 });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps an old fetched observation masked until the matching request resolves', async () => {
    // ES2022's configured Promise API has no withResolvers; retain the test gate resolver.
    let finish: ((response: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((identity: string) => identity === 'A' ? Promise.resolve(Response.json({ value: 0 })) : new Promise<Response>((resolve) => { finish = resolve; })));
    function Observation({ identity }: { identity: string }) {
      const settled = useDebouncedValue(identity);
      const [row, setRow] = useState<{ identity: string; value: number }>();
      useEffect(() => {
        let active = true;
        void fetch(settled).then((response) => response.json()).then((data: { value: number }) => { if (active) setRow({ identity: settled, value: data.value }); });
        return () => { active = false; };
      }, [settled]);
      const busy = identity !== settled || row?.identity !== identity;
      return <section aria-label="Evidence" aria-busy={busy}>{busy ? 'Updating filters…' : <output aria-label="Recorded value">{row?.value}</output>}</section>;
    }
    const view = render(<Observation identity="A" />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByLabelText('Recorded value')).toHaveTextContent('0');
    view.rerender(<Observation identity="B" />);
    expect(screen.getByLabelText('Evidence')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByLabelText('Recorded value')).not.toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(screen.queryByLabelText('Recorded value')).not.toBeInTheDocument();
    await act(async () => { finish?.(Response.json({ value: 7 })); });
    expect(screen.getByLabelText('Recorded value')).toHaveTextContent('7');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
