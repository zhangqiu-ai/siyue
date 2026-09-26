import React from 'react';
import ReactDOM from 'react-dom/client';
import { LocaleProvider } from './i18n';
import { WorkspaceRoot } from './WorkspaceRoot';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><LocaleProvider><WorkspaceRoot /></LocaleProvider></React.StrictMode>,
);
