import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  root: 'src/renderer',
  base: './',
  plugins: [react(), ...(command === 'build' ? [{
    name: 'siyue-production-csp',
    transformIndexHtml: () => [{
      tag: 'meta',
      attrs: {
        'http-equiv': 'Content-Security-Policy',
        content: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'",
      },
      injectTo: 'head-prepend' as const,
    }],
  }] : [])],
  build: { outDir: '../../dist/renderer', emptyOutDir: true },
}));
