import { makeEnvironmentProviders } from '@angular/core';
import { ActivityChart } from './components/activity-chart';
import { ContributorList } from './components/contributor-list';
import { ErrorFallback } from './components/error-fallback';
import { Grid } from './components/grid';
import { IssueTable } from './components/issue-table';
import { Section } from './components/section';
import { StatCard } from './components/stat-card';
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
  ErrorFallback,
};

export function provideGenUi() {
  return makeEnvironmentProviders([{ provide: GENUI_REGISTRY, useValue: REGISTRY }]);
}
