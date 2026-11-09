import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach } from 'vitest';
// Vitest 3 aliases window to Node's global. Node 26's native storage getter
// shadows jsdom storage, so bind the real origin-scoped DOM implementation.
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const environment = globalThis as typeof globalThis & {jsdom: {window: Window}};
Object.defineProperty(globalThis, 'localStorage', {configurable: true, value: environment.jsdom.window.localStorage});
afterAll(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});
afterEach(cleanup);
