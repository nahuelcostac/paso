import { useEffect, useState } from 'react';
const resolvedTheme = (): 'light' | 'dark' => {
  const explicit = document.documentElement.dataset.theme;
  return explicit === 'dark' || (explicit !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
};
export function useTheme() {
  const [theme, setTheme] = useState(resolvedTheme);
  useEffect(() => {
    const sync = () => setTheme(resolvedTheme());
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    query.addEventListener('change', sync);
    return () => { observer.disconnect(); query.removeEventListener('change', sync); };
  }, []);
  return theme;
}
