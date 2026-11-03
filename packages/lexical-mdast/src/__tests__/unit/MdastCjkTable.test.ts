/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {isCjkCharacter} from '@lexical/markdown/src/utils';
import {classifyCharacter, isCjk} from 'micromark-extension-cjk-friendly-util';
import {expect, it} from 'vitest';

it('reads CJK characters as micromark-extension-cjk-friendly does', () => {
  const differences: string[] = [];
  for (let code = 0; code <= 0x3ffff; code++) {
    if (code >= 0xd800 && code <= 0xdfff) {
      continue;
    }
    if (
      isCjkCharacter(String.fromCodePoint(code)) !==
      isCjk(classifyCharacter(code))
    ) {
      differences.push(code.toString(16));
    }
  }
  expect(differences).toEqual([]);
});
