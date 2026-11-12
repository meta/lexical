/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The promise of the composition hold-back (see Hidden), checked over line
// shapes, collaborators' changes, and the ways a composition ends:
//
// - While the local editor composes (IME) in a line, a collaborator's change
//   to that line that Yjs keeps whole (an insert, a format, a comment, a
//   split, a change of the line's type) does not change the line's nodes:
//   the browser composes into their DOM. A change that removes something
//   (a deletion, a join, a comment wrapped around text, which moves it) is
//   read at once, and the node being composed keeps its key and its line,
//   unless its class changes (a code line made a heading).
// - When the composition ends (completed, cancelled, cut short by a blur),
//   or the local editor changes the line's structure while composing (Enter,
//   Shift+Enter, Backspace or Delete across lines, a paste, a change of the
//   line's type, after which the composition goes on), every held change
//   shows where it is: the editor equals a fresh read of its document, as
//   every peer's does, and nothing a collaborator did is lost.
//
// The matrix is in ../utils/compositionHoldBack.ts; part of it runs with
// BlockIdExtension in CompositionHoldBackBlockIds.test.ts.

import {describe, test} from 'vitest';

import {ENDS, REMOTE, runCase, SHAPES} from '../utils/compositionHoldBack';

describe('@lexical/y composition hold-back', () => {
  for (const [shapeName, shape] of Object.entries(SHAPES)) {
    for (const [remoteName, remote] of Object.entries(REMOTE)) {
      for (const end of ENDS) {
        for (const ids of [
          [1, 2],
          [2, 1],
        ]) {
          test(`${shapeName} line, remote ${remoteName}, ${end} (ids ${ids})`, async () => {
            await runCase(shape, remote, end, ids);
          });
        }
      }
    }
  }
});
