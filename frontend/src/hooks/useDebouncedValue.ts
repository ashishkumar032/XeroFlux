import { useEffect, useState } from 'react';

/** Keep the initial identity immediate and settle subsequent manual selections. */
export function useDebouncedValue<T>(value: T, delayMs = 200): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (Object.is(value, settled)) return;
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs, settled]);
  return settled;
}
