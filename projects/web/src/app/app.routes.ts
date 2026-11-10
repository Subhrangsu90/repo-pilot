import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    title: 'RepoPilot · GitHub in plain English',
    loadComponent: () => import('./features/landing/landing').then((m) => m.Landing),
  },
  {
    path: '',
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
        path: 'releases',
        title: 'Releases · RepoPilot',
        loadComponent: () => import('./features/releases/release-builder').then((m) => m.ReleaseBuilder),
      },
      {
        path: 'playground',
        title: 'Playground · RepoPilot',
        loadComponent: () => import('./features/playground/playground').then((m) => m.Playground),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
