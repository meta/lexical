/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @ts-check
import {fileURLToPath} from 'node:url';

import transformErrorMessages from '../error-codes/transform-error-messages.mjs';

/**
 * Shared by package builds and source benchmarks. Resolve Browserslist from
 * the repository root even when invoked from another working directory.
 * @param {boolean} isProd
 * @param {boolean} [extractCodes]
 * @returns {Omit<import('@babel/core').InputOptions, 'include' | 'exclude'>}
 */
export function getBuildBabelOptions(isProd, extractCodes = false) {
  return {
    babelrc: false,
    browserslistConfigFile: fileURLToPath(
      new URL('../../package.json', import.meta.url),
    ),
    configFile: false,
    // JSX only parses in .jsx/.tsx files. Applying preset-react
    // unconditionally would enable the jsx syntax plugin for plain .ts
    // too, where `<T>` in a generic arrow function (`<T>(x: T) => ...`)
    // is ambiguous with an opening JSX element and fails to parse.
    overrides: [
      {
        presets: [
          // Pin development:false so the automatic runtime always emits the
          // production `jsx`/`jsxs` helpers, never `jsxDEV`. Babel 8 flipped the
          // default to infer development mode from the environment, which made
          // the dev builds import `react/jsx-dev-runtime`; consumers that bundle
          // those dev builds (e.g. the Docusaurus website SSG) then crash with
          // "jsxDEV is not a function".
          ['@babel/preset-react', {development: false, runtime: 'automatic'}],
        ],
        test: /\.[jt]sx$/,
      },
    ],
    plugins: [[transformErrorMessages, {extractCodes, noMinify: !isProd}]],
    presets: [
      ['@babel/preset-env', {modules: false}],
      '@babel/preset-typescript',
    ],
  };
}

/** @satisfies {import('@rollup/plugin-terser').Options} */
export const productionTerserOptions = {
  // Preserve Infinity and annotations for downstream tree shaking.
  compress: {keep_infinity: true, passes: 2},
  ecma: 2021,
  format: {ascii_only: true, preserve_annotations: true},
};
