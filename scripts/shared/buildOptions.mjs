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

const EXTRACT_CODES_ON = new Set(['1', 'true', 'yes', 'on']);
const EXTRACT_CODES_OFF = new Set(['', '0', 'false', 'no', 'off']);

/**
 * Whether a build assigns new production error codes, writing them to
 * `scripts/error-codes/codes.json`. Builds do not by default, because a code
 * is only stable once codes.json is committed: two builds of one commit
 * could number a new message differently, so its message stays as full text
 * in the production build instead. Extraction is opted into explicitly,
 * with `--codes` (`pnpm run extract-codes`, which the `latest` version bump
 * runs and commits) or `LEXICAL_EXTRACT_CODES=true` (or `1`, `yes`, `on`).
 *
 * @param {unknown} codesFlag the parsed `--codes` argument
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function shouldExtractCodes(codesFlag, env = process.env) {
  const value = (env.LEXICAL_EXTRACT_CODES ?? '').trim().toLowerCase();
  if (!EXTRACT_CODES_ON.has(value) && !EXTRACT_CODES_OFF.has(value)) {
    throw new Error(
      `Unrecognized LEXICAL_EXTRACT_CODES=${JSON.stringify(
        env.LEXICAL_EXTRACT_CODES,
      )}: use true to also assign new error codes, or false`,
    );
  }
  return Boolean(codesFlag) || EXTRACT_CODES_ON.has(value);
}

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
