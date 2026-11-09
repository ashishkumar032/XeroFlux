import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';

export type Theme = 'light' | 'dark';
export type ThemeColors = {
  background: string; surface: string; text: string; muted: string; border: string; accent: string;
  mapBackground: string; mapNoData: string; mapBorder: string; mapSelected: string;
  rainLow: string; rainHigh: string; event: string; cyclone: string; activePoint: string;
};
const palettes: Record<Theme, ThemeColors> = {
  light: {
    background: '#f3f7f1', surface: '#ffffff', text: '#193b2b', muted: '#587061', border: '#d6e2d5', accent: '#267448',
    mapBackground: '#edf4eb', mapNoData: '#d9e1d8', mapBorder: '#899d8d', mapSelected: '#166534',
    rainLow: '#bce3dd', rainHigh: '#247b6c', event: '#217d55', cyclone: '#8054b3', activePoint: '#b56712',
  },
  dark: {
    background: '#0b1720', surface: '#11232d', text: '#e5efe9', muted: '#a1b7ac', border: '#2b4549', accent: '#7bd4a4',
    mapBackground: '#0b1720', mapNoData: '#39465a', mapBorder: '#8da1b8', mapSelected: '#7af1da',
    rainLow: '#b4e0ed', rainHigh: '#147ba6', event: '#18b6a4', cyclone: '#b69af0', activePoint: '#fff0a8',
  },
};
const ThemeContext = createContext<{theme: Theme; colors: ThemeColors; toggleTheme: () => void} | undefined>(undefined);

export function ThemeProvider({children}: {children: ReactNode}) {
  const [theme, setTheme] = useState<Theme>(() => {
    try { return window.localStorage.getItem('climatelens-theme') === 'dark' ? 'dark' : 'light'; }
    catch { return 'light'; }
  });
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', palettes[theme].background);
    try { window.localStorage.setItem('climatelens-theme', theme); } catch { /* Theme still works when browser storage is unavailable. */ }
  }, [theme]);
  const toggleTheme = useCallback(() => setTheme(current => current === 'light' ? 'dark' : 'light'), []);
  const value = useMemo(() => ({theme, colors: palettes[theme], toggleTheme}), [theme, toggleTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('ThemeProvider is required for the dashboard theme.');
  return context;
}
