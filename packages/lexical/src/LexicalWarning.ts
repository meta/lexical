/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * A warning with a stable code, passed to the editor's `onWarn` by packages
 * that report recoverable, warn-level conditions. It is an `Error`, so a
 * handler written for `onWarn` keeps working; check
 * `instanceof LexicalWarning` to read `code` and `data`.
 *
 * The code is a string namespaced by the package that reports it
 * (`'@example/pkg/some-condition'`); each package documents its codes and
 * what `data` holds for each. A `switch` over codes needs a `default`
 * branch, since packages may add codes in any release.
 *
 * ```ts
 * onWarn(error) {
 *   if (error instanceof LexicalWarning) {
 *     switch (error.code) {
 *       case '@example/pkg/some-condition':
 *         report(error.message, error.data);
 *         return;
 *       default:
 *         break;
 *     }
 *   }
 *   console.warn(error);
 * }
 * ```
 */
export class LexicalWarning extends Error {
  /** What happened, namespaced by the package that reports it. */
  readonly code: string;
  /**
   * Details for programs, documented with each code (the message is for
   * people and may change).
   */
  readonly data?: unknown;
  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = 'LexicalWarning';
    this.code = code;
    this.data = data;
  }
}
