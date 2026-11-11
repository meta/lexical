/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {toHaveNoViolations} from 'jest-axe';

import 'vitest';

// @types/jest-axe augments Jest's matchers, which Vitest 5 no longer inherits.
// Reuse its matcher signatures, including their assertion return type.
declare module 'vitest' {
  interface Matchers<R extends void | Promise<void>> extends Pick<
    jest.Matchers<R>,
    keyof typeof toHaveNoViolations
  > {}
}
