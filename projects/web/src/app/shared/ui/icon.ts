import { Component, input } from '@angular/core';

export type IconName =
  | 'ask'
  | 'send'
  | 'check'
  | 'cross'
  | 'sun'
  | 'moon'
  | 'arrow-right'
  | 'refresh';

/**
 * Stroke icons from the RepoPilot designs, drawn in currentColor. Decorative
 * by default (aria-hidden); give the surrounding control an aria-label.
 */
@Component({
  selector: 'app-icon',
  host: { class: 'inline-flex shrink-0', 'aria-hidden': 'true' },
  template: `
    <svg
      [attr.width]="size()"
      [attr.height]="size()"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      [attr.stroke-width]="stroke()"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      @switch (name()) {
        @case ('ask') {
          <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18" />
        }
        @case ('send') {
          <path d="M5 12h14M13 6l6 6-6 6" />
        }
        @case ('arrow-right') {
          <path d="M5 12h14M13 6l6 6-6 6" />
        }
        @case ('check') {
          <path d="M5 12l5 5 9-10" />
        }
        @case ('cross') {
          <path d="M6 6l12 12M18 6L6 18" />
        }
        @case ('sun') {
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        }
        @case ('moon') {
          <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
        }
        @case ('refresh') {
          <path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" />
        }
      }
    </svg>
  `,
})
export class Icon {
  readonly name = input.required<IconName>();
  readonly size = input(18);
  readonly stroke = input(2);
}
