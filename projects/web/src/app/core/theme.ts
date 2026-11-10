import { DOCUMENT, effect, inject, Injectable, signal } from '@angular/core';

export type ThemeName = 'graphite' | 'light';

/** localStorage key; index.html reads the same key before first paint. */
export const THEME_KEY = 'repopilot-theme';

/**
 * Graphite is the default; Light is a per-browser choice. The current theme
 * lives on <html data-theme>, which switches every design token at once.
 */
@Injectable({ providedIn: 'root' })
export class Theme {
  private readonly root = inject(DOCUMENT).documentElement;

  readonly current = signal<ThemeName>(this.root.dataset['theme'] === 'light' ? 'light' : 'graphite');

  constructor() {
    effect(() => {
      const theme = this.current();
      this.root.dataset['theme'] = theme;
      try {
        localStorage.setItem(THEME_KEY, theme);
      } catch {
        // Private mode or blocked storage: the choice just won't persist.
      }
    });
  }

  toggle(): void {
    this.current.update((t) => (t === 'graphite' ? 'light' : 'graphite'));
  }
}
