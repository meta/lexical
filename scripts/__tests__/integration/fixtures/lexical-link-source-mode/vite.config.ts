/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {pureAnnotations} from '@lexical/compiler/PureAnnotations';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';

// Consuming lexical via the `source` export condition needs almost no extra
// config: imports resolve through normal package resolution
// (`@lexical/internal/*` is a real dependency, the react/test helpers are
// package-internal) and the dev/prod branch uses `process.env.NODE_ENV`,
// which Vite substitutes out of the box. The opt-ins are the `source`
// resolve condition and the @lexical/compiler plugin, which adds the
// /* @__PURE__ */ annotations that the published dist bundles carry but the
// TypeScript sources do not (they are injected by Lexical's own build).
const fixtureDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    lib: {
      entry: path.resolve(fixtureDir, 'src/main.ts'),
      fileName: 'main',
      formats: ['es'],
    },
    minify: false,
    rollupOptions: {output: {entryFileNames: 'main.mjs'}},
    sourcemap: false,
    target: 'es2022',
  },
  // `inline` reproduces the bodies of the trivial factories, so it is opt-in
  // for consumers and expects a matching Lexical version — which a fixture
  // linked against this checkout has by construction.
  plugins: [pureAnnotations({inline: true})],
  resolve: {
    conditions: ['source', 'development', 'module', 'browser', 'default'],
  },
});
