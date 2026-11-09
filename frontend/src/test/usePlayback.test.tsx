import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlayback } from '../hooks/usePlayback';

// Test-only source labels. The consumer calls the production hook directly.
const observations = ['2019-04-26T00:00:00Z', '2019-04-26T03:00:00Z', '2019-04-26T09:00:00Z'];
function Consumer({ records = observations, identity = 'storm-a' }: { records?: string[]; identity?: string }) {
  const playback = usePlayback(records.length, identity);
  return <>
    <output aria-label="Current source timestamp">{records[playback.index] ?? 'No observations'}</output>
    <output aria-label="Playback status">{playback.playing ? 'Playing' : 'Paused'}</output>
    <button onClick={playback.play} disabled={records.length < 2}>Play</button>
    <button onClick={playback.pause}>Pause</button>
    <button onClick={playback.restart} disabled={!records.length}>Restart</button>
    <button onClick={playback.step} disabled={records.length < 2 || playback.index === records.length - 1}>Step</button>
    <label>Speed<select value={playback.speed} onChange={event => playback.setSpeed(Number(event.target.value))}>
      <option value="0.5">0.5×</option><option value="1">1×</option><option value="2">2×</option>
    </select></label>
    <label>Timeline<input type="range" min="0" max={Math.max(0, records.length - 1)} value={playback.index} disabled={!records.length} onChange={event => playback.seek(Number(event.target.value))} /></label>
  </>;
}
const timestamp = () => screen.getByLabelText('Current source timestamp');
const advance = (milliseconds: number) => act(() => vi.advanceTimersByTime(milliseconds));
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('observed-record playback', () => {
  it('advances the visible source timestamp, pauses, steps and stops at the final observation', () => {
    render(<Consumer />);
    expect(timestamp()).toHaveTextContent(observations[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    advance(999);
    expect(timestamp()).toHaveTextContent(observations[0]);
    advance(1);
    expect(timestamp()).toHaveTextContent(observations[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    advance(3000);
    expect(timestamp()).toHaveTextContent(observations[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Step' }));
    expect(timestamp()).toHaveTextContent(observations[2]);
    expect(screen.getByLabelText('Playback status')).toHaveTextContent('Paused');
    expect(screen.getByRole('button', { name: 'Step' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(timestamp()).toHaveTextContent(observations[0]);
    advance(1000);
    advance(1000);
    expect(timestamp()).toHaveTextContent(observations[2]);
    expect(screen.getByLabelText('Playback status')).toHaveTextContent('Paused');
    expect(vi.getTimerCount()).toBe(0);
    advance(5000);
    expect(timestamp()).toHaveTextContent(observations[2]);
  });

  it('restarts paused and seeks without continuing an old timer', () => {
    render(<Consumer />);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    advance(1000);
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(timestamp()).toHaveTextContent(observations[0]);
    expect(screen.getByLabelText('Playback status')).toHaveTextContent('Paused');
    advance(2000);
    expect(timestamp()).toHaveTextContent(observations[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    fireEvent.change(screen.getByLabelText('Timeline'), { target: { value: '2' } });
    expect(timestamp()).toHaveTextContent(observations[2]);
    expect(screen.getByLabelText('Playback status')).toHaveTextContent('Paused');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses 0.5×, 1× and 2× as observation-step speeds and clears replaced timers', () => {
    render(<Consumer />);
    fireEvent.change(screen.getByLabelText('Speed'), { target: { value: '0.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    advance(1999);
    expect(timestamp()).toHaveTextContent(observations[0]);
    advance(1);
    expect(timestamp()).toHaveTextContent(observations[1]);
    fireEvent.change(screen.getByLabelText('Speed'), { target: { value: '2' } });
    expect(vi.getTimerCount()).toBe(1);
    advance(499);
    expect(timestamp()).toHaveTextContent(observations[1]);
    advance(1);
    expect(timestamp()).toHaveTextContent(observations[2]);
    expect(screen.getByLabelText('Playback status')).toHaveTextContent('Paused');
    fireEvent.change(screen.getByLabelText('Speed'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    advance(1000);
    expect(timestamp()).toHaveTextContent(observations[1]);
  });

  it('resets and pauses on storm identity or record-count changes and clears timers on unmount', () => {
    const view = render(<Consumer />);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    advance(1000);
    view.rerender(<Consumer identity="storm-b" records={['2020-01-01', '2020-01-02']} />);
    expect(timestamp()).toHaveTextContent('2020-01-01');
    expect(screen.getByLabelText('Playback status')).toHaveTextContent('Paused');
    expect(vi.getTimerCount()).toBe(0);
    advance(2000);
    expect(timestamp()).toHaveTextContent('2020-01-01');
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    view.rerender(<Consumer identity="storm-b" records={['2020-01-01']} />);
    expect(timestamp()).toHaveTextContent('2020-01-01');
    expect(screen.getByLabelText('Playback status')).toHaveTextContent('Paused');
    view.rerender(<Consumer identity="storm-b" />);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    advance(2000);
  });

  it('allows inspection of one observation and disables empty or single-record motion', () => {
    const view = render(<Consumer records={[observations[0]]} />);
    expect(timestamp()).toHaveTextContent(observations[0]);
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Step' })).toBeDisabled();
    expect(screen.getByLabelText('Timeline')).not.toBeDisabled();
    view.rerender(<Consumer records={[]} />);
    expect(timestamp()).toHaveTextContent('No observations');
    for (const name of ['Play', 'Step', 'Restart']) expect(screen.getByRole('button', { name })).toBeDisabled();
    expect(screen.getByLabelText('Timeline')).toBeDisabled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
