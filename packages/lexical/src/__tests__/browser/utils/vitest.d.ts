/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {browserCommands} from '../../../../../../scripts/vitest/browserCommands.ts';
import type {BrowserCommandContext} from 'vitest/node';

import 'vitest/browser';

// The browser project's custom commands, as tests call them: without the
// context argument Vitest passes on the server side, and always async.
type ClientCommands<Commands> = {
  [Name in keyof Commands]: Commands[Name] extends (
    context: BrowserCommandContext,
    ...args: infer Args
  ) => infer Result
    ? (...args: Args) => Promise<Awaited<Result>>
    : never;
};

declare module 'vitest/browser' {
  interface BrowserCommands extends ClientCommands<typeof browserCommands> {}
}
