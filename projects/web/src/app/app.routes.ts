import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'playground' },
  {
    path: 'playground',
    title: 'Playground · RepoPilot',
    loadComponent: () => import('./features/playground/playground').then((m) => m.Playground),
  },
  { path: '**', redirectTo: 'playground' },
];
