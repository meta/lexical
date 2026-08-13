/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  getCodeLanguageOptions,
  getLanguageFriendlyName,
  isCodeLanguageLoaded,
  normalizeCodeLanguage,
} from '@lexical/code-prism';
import {describe, expect, test} from 'vitest';

describe('Prism code language options', () => {
  test('includes Go (#7704)', () => {
    expect(getCodeLanguageOptions()).toContainEqual(['go', 'Go']);
    expect(getLanguageFriendlyName('go')).toBe('Go');
    expect(normalizeCodeLanguage('golang')).toBe('go');
    expect(isCodeLanguageLoaded('go')).toBe(true);
  });

  test('returns a string for a language named after an Object member', () => {
    // A markdown fence carries whatever the author typed, so these arrive as
    // ordinary language names. Read off the prototype they come back as
    // functions and reach the DOM as the source text of `Object`.
    for (const lang of [
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
      'isPrototypeOf',
      '__proto__',
    ]) {
      expect(normalizeCodeLanguage(lang)).toBe(lang);
      expect(getLanguageFriendlyName(lang)).toBe(lang);
    }
  });

  test('still maps and names the languages it knows', () => {
    expect(normalizeCodeLanguage('javascript')).toBe('js');
    expect(getLanguageFriendlyName('javascript')).toBe('JavaScript');
    expect(normalizeCodeLanguage('rust')).toBe('rust');
    expect(getLanguageFriendlyName('rust')).toBe('Rust');
  });
});
