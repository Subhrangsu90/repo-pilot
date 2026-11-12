import { Component } from '@angular/core';
import { Icon } from './icon';

/**
 * Marks an issue or pull request whose title the server flagged as a possible
 * prompt injection (`injection: true` in IssueRow / PrCard). A warning, not a
 * status: neutral badge with a strong border, never `risk` (design system).
 */
@Component({
  selector: 'app-injection-badge',
  imports: [Icon],
  host: { class: 'inline-flex' },
  template: `
    <span
      class="badge gap-1.5 border border-border-strong px-2 py-0.5 font-normal"
      title="This title contains text addressed to an AI. RepoPilot treats it as data and does not follow it."
    >
      <app-icon name="warning" [size]="12" />
      Possible prompt injection
    </span>
  `,
})
export class InjectionBadge {}
