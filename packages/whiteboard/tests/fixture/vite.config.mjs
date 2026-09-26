// Plain object on purpose: the whiteboard package owns no bundler dependency, so the spec drives
// the Electron app's vite binary with this config instead of importing vite's defineConfig.
export default {
  root: import.meta.dirname,
  base: './',
  build: { target: 'esnext', minify: false, sourcemap: false, emptyOutDir: true },
};
