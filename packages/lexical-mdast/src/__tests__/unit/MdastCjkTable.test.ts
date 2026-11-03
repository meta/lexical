/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import isCjkCharacter from '@lexical/internal/isCjkCharacter';
import {eastAsianWidthType} from 'get-east-asian-width';
import {expect, it} from 'vitest';

// The amendment's definition of a CJK character, from the width data.
function isCjkByWidth(code: number): boolean {
  const character = String.fromCodePoint(code);
  switch (eastAsianWidthType(code)) {
    case 'fullwidth':
    case 'halfwidth':
      return true;
    case 'wide':
      return !/\p{Emoji_Presentation}/u.test(character);
    case 'neutral':
      return /\p{sc=Hangul}/u.test(character);
    default:
      return false;
  }
}

it('reads CJK characters as the East Asian Width data does', () => {
  const differences: string[] = [];
  for (let code = 0x1100; code <= 0x3ffff; code++) {
    if (code >= 0xd800 && code <= 0xdfff) {
      continue;
    }
    if (isCjkCharacter(String.fromCodePoint(code)) !== isCjkByWidth(code)) {
      differences.push(code.toString(16));
    }
  }
  expect(differences).toEqual([]);
});
