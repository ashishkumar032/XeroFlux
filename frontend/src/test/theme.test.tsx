import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from '../theme';

function ThemeControl() {
  const {theme, toggleTheme} = useTheme();
  return <button role="switch" aria-label="Dark mode" aria-checked={theme==='dark'} onClick={toggleTheme}>Change appearance</button>;
}
beforeEach(()=>{window.localStorage.clear();delete document.documentElement.dataset.theme;});
afterEach(()=>vi.restoreAllMocks());

describe('Appearance preferences',()=>{
  it('changes the document theme, remembers a selection, and restores it on remount',()=>{
    const view=render(<ThemeProvider><ThemeControl/></ThemeProvider>);
    const control=screen.getByRole('switch',{name:'Dark mode'});
    expect(control).not.toBeChecked();
    fireEvent.click(control);
    expect(document.documentElement).toHaveAttribute('data-theme','dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(window.localStorage.getItem('climatelens-theme')).toBe('dark');
    view.unmount();
    render(<ThemeProvider><ThemeControl/></ThemeProvider>);
    expect(screen.getByRole('switch',{name:'Dark mode'})).toBeChecked();
    fireEvent.click(screen.getByRole('switch',{name:'Dark mode'}));
    expect(document.documentElement).toHaveAttribute('data-theme','light');
    expect(window.localStorage.getItem('climatelens-theme')).toBe('light');
  });
  it('keeps the switch usable when browser storage cannot be read',()=>{
    vi.spyOn(window.Storage.prototype,'getItem').mockImplementation(()=>{throw new DOMException('Storage denied','SecurityError');});
    render(<ThemeProvider><ThemeControl/></ThemeProvider>);
    fireEvent.click(screen.getByRole('switch',{name:'Dark mode'}));
    expect(screen.getByRole('switch',{name:'Dark mode'})).toBeChecked();
    expect(document.documentElement).toHaveAttribute('data-theme','dark');
  });
  it('changes appearance even when the browser refuses preference writes',()=>{
    vi.spyOn(window.Storage.prototype,'setItem').mockImplementation(()=>{throw new DOMException('Quota denied','QuotaExceededError');});
    render(<ThemeProvider><ThemeControl/></ThemeProvider>);
    fireEvent.click(screen.getByRole('switch',{name:'Dark mode'}));
    expect(document.documentElement).toHaveAttribute('data-theme','dark');
    fireEvent.click(screen.getByRole('switch',{name:'Dark mode'}));
    expect(document.documentElement).toHaveAttribute('data-theme','light');
  });
});
