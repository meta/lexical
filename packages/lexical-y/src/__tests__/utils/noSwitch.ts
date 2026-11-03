/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Layout 3 only: the identity-writes switch is gone (every document this
// binding writes records layout 3 and gets paired runs). The calls tests made
// to turn it on stay as no-ops; a test that turned it off to check today's
// writer was removed or rewritten.

/** No-op (the switch is gone). */
export function setFormatIdentityWrites(_doc: unknown, _on: boolean): void {}

/** No-op (the switch is gone). */
export function setFormatIdentityWritesDefault(_on: boolean): void {}
