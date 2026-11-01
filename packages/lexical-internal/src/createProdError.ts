/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Used by the error-message transform. Call createError or invariant in source.
export default function createProdError(
  code: string,
  ...args: string[]
): Error {
  const url = new URL('https://lexical.dev/docs/error');
  const params = new URLSearchParams();
  params.append('code', code);
  for (const arg of args) {
    params.append('v', arg);
  }
  url.search = params.toString();

  return new Error(
    `Minified Lexical error #${code}; visit ${url.toString()} for the full message or use the non-minified dev environment for full errors and additional helpful warnings.`,
  );
}
