/**
 * Client-bundle build (tsdown) — the standard DSH client pipeline:
 * plain-ESM source (src/client.ts) bundled to CJS and wrapped in the
 * __ModuleLoader__.load({ id, factory }) shell the web profile requires.
 *
 * Externals are the shared modules resolved through the shell's frozen
 * module table at runtime; everything else inlines. React MUST stay
 * external: the shell owns the only React instance.
 */
import { fileURLToPath } from 'node:url'

/** Module specifiers the web shell / dshloader share into the module table. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
  '@dsh-plugin/dsh-loader/client',
]

export default {
  entry: { client: fileURLToPath(new URL('./src/client.ts', import.meta.url)) },
  outDir: fileURLToPath(new URL('./lib', import.meta.url)),
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  noExternal: (id) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  inputOptions: {
    resolve: {
      conditionNames: ['browser', 'import', 'require', 'default'],
    },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "@dsh-plugin/dsh-network-settings", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}
