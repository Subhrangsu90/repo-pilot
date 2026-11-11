import { Component, input } from '@angular/core';

/** The RepoPilot mark (a filled tile with a heading arrow) plus the word mark. */
@Component({
  selector: 'app-logo',
  host: { class: 'inline-flex items-center gap-2.5' },
  template: `
    <svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 28 28" aria-hidden="true">
      <rect x="1" y="1" width="26" height="26" rx="8" class="fill-primary" />
      <path d="M8.5 19.5 L14 7.5 L19.5 19.5 L14 16 Z" class="fill-on-primary" />
    </svg>
    <span class="font-display text-lg font-bold tracking-tight text-fg">RepoPilot</span>
  `,
})
export class Logo {
  readonly size = input(28);
}
