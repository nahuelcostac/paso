import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { configFromPage } from './lib/api';
import { restoreTheme } from './lib/theme';
import { markWindowControls } from './lib/desktop';
import './styles/tokens.css';
import './styles/app.css';

restoreTheme();
markWindowControls();

createRoot(document.getElementById('root')!).render(
  <StrictMode><App config={configFromPage()} /></StrictMode>,
);
