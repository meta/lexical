/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import babel from '@rollup/plugin-babel';
import react from '@vitejs/plugin-react';
import {defineConfig, type PluginOption, type UserConfig} from 'vite';

import transformErrorMessages from '../../scripts/error-codes/transform-error-messages.mjs';
import viteMonorepoResolutionPlugin from '../../scripts/vite/lexicalMonorepoPlugin.ts';
import viteCopyEsm from './viteCopyEsm.ts';
import viteCopyExcalidrawAssets from './viteCopyExcalidrawAssets.ts';

// react() returns Plugin[]; widening it to PluginOption[] here lets the plugins
// array below infer as PluginOption[] (every other entry is a Plugin, which is
// a PluginOption) without annotating the whole array. That matters because
// comparing the inferred plugin union against vite's recursively-defined
// PluginOption type overflows with "Excessive stack depth" on newer vite type
// definitions; widening the one array-valued entry keeps the check shallow.
const reactPlugins: PluginOption[] = react();

// https://vitejs.dev/config/
export default defineConfig(
  ({mode}): UserConfig => ({
    build: {
      outDir: 'build',
      rollupOptions: {
        input: {
          main: new URL('./index.html', import.meta.url).pathname,
          split: new URL('./split/index.html', import.meta.url).pathname,
        },
      },
      target: 'es2022',
      ...(mode === 'production'
        ? {
            minify: 'terser',
            terserOptions: {
              compress: {
                toplevel: true,
              },
              keep_classnames: true,
            },
          }
        : {minify: false}),
    },
    plugins: [
      viteMonorepoResolutionPlugin(),
      babel({
        babelHelpers: 'bundled',
        babelrc: false,
        configFile: false,
        exclude: '**/node_modules/**',
        extensions: ['jsx', 'js', 'ts', 'tsx', 'mjs'],
        plugins: [
          '@babel/plugin-transform-flow-strip-types',
          ...(mode !== 'production'
            ? [
                [
                  transformErrorMessages,
                  {
                    noMinify: true,
                  },
                ],
              ]
            : []),
        ],
        presets: [['@babel/preset-react', {runtime: 'automatic'}]],
      }),
      ...reactPlugins,
      ...viteCopyExcalidrawAssets(),
      viteCopyEsm(),
    ],
  }),
);
