import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { applyMode, Mode } from '@cloudscape-design/global-styles';
import '@cloudscape-design/global-styles/index.css';
import './index.css';
import { App } from './App';

applyMode(
  window.matchMedia?.('(prefers-color-scheme: dark)').matches ? Mode.Dark : Mode.Light,
  document.documentElement,
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
