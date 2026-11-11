/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import createDevError from './createDevError';

/**
 * Construct an error without throwing it. Like invariant, the message must be
 * a literal with %s placeholders so builds can replace it with an error code.
 * The source implementation also works without the build transform.
 */
export default function createError(message: string, ...args: string[]): Error {
  let index = 0;
  return createDevError(
    args.length === 0
      ? message
      : message.replace(/%s/g, () => String(args[index++])),
  );
}
