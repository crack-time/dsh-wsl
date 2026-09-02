// tsdown client bundle protocol (mirrors DSH packages/client/tsdown.client.ts):
// input  = lib/client/index.js (tsc client program output)
// output = lib/client.js (CJS closure-factory, window.__ModuleLoader__.load format)
import { defineConfig } from 'tsdown'

export default defineConfig({
  name: '@crack/dsh-wsl/client',
  entry: { client: 'lib/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  // react / react-dom are platform modules: the browser ModuleLoader resolves
  // them from the frozen module table, never bundled.
  deps: {
    neverBundle: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  },
  dts: false,
  sourcemap: true,
  clean: false,
  minify: false,
  hash: false,
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "@crack/dsh-wsl", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})