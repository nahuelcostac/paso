import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { configFromPage } from './lib/api';
import { restoreTheme } from './lib/theme';
import './styles/tokens.css';
import './styles/app.css';

restoreTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode><App config={configFromPage()} /></StrictMode>,
);
