import { useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'rack-planner-theme';

/** Returns the stored theme (defaults to dark) */
export const getStoredTheme = (): Theme => {
  try {
    const t = localStorage.getItem(STORAGE_KEY);
    return t === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
};

/**
 * React hook that keeps the document's `data-theme` attribute and an internal
 * state in sync. Persists the user preference to localStorage.
 */
export const useTheme = (): [Theme, () => void] => {
  const [theme, setTheme] = useState<Theme>(getStoredTheme());

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // storage unavailable – ignore
    }
  }, [theme]);

  const toggleTheme = () => setTheme(t => (t === 'dark' ? 'light' : 'dark'));

  return [theme, toggleTheme];
};
