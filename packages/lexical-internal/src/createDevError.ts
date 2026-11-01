/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Used by the error-message transform. Call createError in source.
export default function createDevError(message: string): Error {
  return new Error(message);
}
