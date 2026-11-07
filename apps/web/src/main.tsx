import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { configFromPage } from './lib/api';
import './styles/tokens.css';
import './styles/app.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode><App config={configFromPage()} /></StrictMode>,
);
