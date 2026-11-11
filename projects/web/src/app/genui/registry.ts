import { makeEnvironmentProviders } from '@angular/core';
import { ActivityChart } from './components/activity-chart';
import { ApprovalCard } from './components/approval-card';
import { ContributorList } from './components/contributor-list';
import { DiffViewer } from './components/diff-viewer';
import { ErrorFallback } from './components/error-fallback';
import { Grid } from './components/grid';
import { IssueTable } from './components/issue-table';
import { PrCard } from './components/pr-card';
import { PrList } from './components/pr-list';
import { PrReview } from './components/pr-review';
import { ReleaseForm } from './components/release-form';
import { Section } from './components/section';
import { StatCard } from './components/stat-card';
import { StepTimeline } from './components/step-timeline';
import { GENUI_REGISTRY, GenUiRegistry } from './registry-token';

/**
 * Typed as Record<ComponentName, ...>: adding a name to the shared catalog
 * without registering a component here fails the build.
 */
export const REGISTRY: GenUiRegistry = {
  Grid,
  Section,
  StatCard,
  ActivityChart,
  IssueTable,
  ContributorList,
  PrCard,
  PrList,
  ApprovalCard,
  DiffViewer,
  PrReview,
  ReleaseForm,
  StepTimeline,
  ErrorFallback,
};

export function provideGenUi() {
  return makeEnvironmentProviders([{ provide: GENUI_REGISTRY, useValue: REGISTRY }]);
}
