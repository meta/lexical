/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {vi} from 'vitest';

import {runKeyDownDispatchParityTests} from './keyDownDispatchParity';

// `vi.mock` is hoisted above all imports, so LexicalEvents.ts compiles its
// keydown shortcut table for the non-Apple platform.
vi.mock('lexical/src/environment', async importOriginal => ({
  ...(await importOriginal<typeof import('lexical/src/environment')>()),
  IS_APPLE: false,
}));

runKeyDownDispatchParityTests(false);
