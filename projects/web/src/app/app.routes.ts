import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    title: 'RepoPilot',
    loadComponent: () => import('./features/chat/chat').then((m) => m.Chat),
  },
  {
    path: 'playground',
    title: 'Playground · RepoPilot',
    loadComponent: () => import('./features/playground/playground').then((m) => m.Playground),
  },
  { path: '**', redirectTo: '' },
];
