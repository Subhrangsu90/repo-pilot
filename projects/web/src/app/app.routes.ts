import { Routes } from '@angular/router';
import { requireSignIn } from './core/auth';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    title: 'RepoPilot · GitHub in plain English',
    loadComponent: () => import('./features/landing/landing').then((m) => m.Landing),
  },
  {
    // Outside the app layout; the app pages send signed-out visitors here (OAuth mode).
    path: 'signin',
    title: 'Sign in · RepoPilot',
    loadComponent: () => import('./features/auth/sign-in').then((m) => m.SignIn),
  },
  {
    path: '',
    canActivate: [requireSignIn],
    loadComponent: () => import('./layout/shell').then((m) => m.Shell),
    children: [
      {
        path: 'ask',
        title: 'Ask · RepoPilot',
        loadComponent: () => import('./features/chat/chat').then((m) => m.Chat),
      },
      {
        path: 'pulls',
        title: 'Pull requests · RepoPilot',
        loadComponent: () => import('./features/pulls/pull-list').then((m) => m.PullList),
      },
      {
        path: 'pulls/:number',
        title: 'Review · RepoPilot',
        loadComponent: () => import('./features/pulls/pull-review').then((m) => m.PullReview),
      },
      {
        path: 'issues',
        title: 'Issues · RepoPilot',
        loadComponent: () => import('./features/issues/issue-list').then((m) => m.IssueList),
      },
      {
        path: 'releases',
        title: 'Releases · RepoPilot',
        loadComponent: () => import('./features/releases/release-builder').then((m) => m.ReleaseBuilder),
      },
      {
        path: 'history',
        title: 'History · RepoPilot',
        loadComponent: () => import('./features/history/history').then((m) => m.History),
      },
      {
        path: 'settings',
        title: 'Profile & settings · RepoPilot',
        loadComponent: () => import('./features/settings/settings').then((m) => m.Settings),
      },
      {
        path: 'audit',
        title: 'Audit log · RepoPilot',
        loadComponent: () => import('./features/audit/audit-log').then((m) => m.AuditLog),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
