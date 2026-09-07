import React from 'react';
import ReactDOM from 'react-dom/client';
import { LocaleProvider } from './i18n';
import { App } from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><LocaleProvider><App /></LocaleProvider></React.StrictMode>,
);
