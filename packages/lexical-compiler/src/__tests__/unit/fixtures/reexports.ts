/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A package root re-exports what other modules declare, the way
// `@lexical/html`'s index does for `sel` and `defineImportRule`. A sibling
// entry that imports from the root gets the declarations' evidence.
export {
  defineImpureThing,
  definePureThing as definePureThingAgain,
  pureThings,
} from './factories';
