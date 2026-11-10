/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The CJK characters of the CommonMark CJK-friendly amendment
// (https://github.com/tats-u/markdown-cjk-friendly): East Asian Width F, H
// and W, without the characters shown as emoji, and the Hangul script, from
// the Unicode 17 data of `get-east-asian-width` 1.7. Unlike the amendment's
// reference implementations, which ask the engine which characters are
// emoji, it reads the same in every engine. The MdastCjkTable test
// compares it with that package: regenerate it when the test fails after an
// update of the package.
const CJK =
  // A range that starts at a combining mark is still a range of code points.
  // eslint-disable-next-line no-misleading-character-class
  /[\u1100-\u11ff\u20a9\u2329\u232a\u2630-\u2637\u268a-\u268f\u2e80-\u2e99\u2e9b-\u2ef3\u2f00-\u2fd5\u2ff0-\u303e\u3041-\u3096\u3099-\u30ff\u3105-\u312f\u3131-\u318e\u3190-\u31e5\u31ef-\u321e\u3220-\u3247\u3250-\ua48c\ua490-\ua4c6\ua960-\ua97c\uac00-\ud7a3\ud7b0-\ud7c6\ud7cb-\ud7fb\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe52\ufe54-\ufe66\ufe68-\ufe6b\uff01-\uffbe\uffc2-\uffc7\uffca-\uffcf\uffd2-\uffd7\uffda-\uffdc\uffe0-\uffe6\uffe8-\uffee\u{16fe0}-\u{16fe4}\u{16ff0}-\u{16ff6}\u{17000}-\u{18cda}\u{18cff}-\u{18d20}\u{18d80}-\u{18df2}\u{18e00}-\u{19191}\u{191a0}-\u{191d2}\u{1aff0}-\u{1aff3}\u{1aff5}-\u{1affb}\u{1affd}\u{1affe}\u{1b000}-\u{1b128}\u{1b132}\u{1b150}-\u{1b152}\u{1b155}\u{1b164}-\u{1b168}\u{1b170}-\u{1b2fb}\u{1d300}-\u{1d356}\u{1d360}-\u{1d376}\u{1f1ae}\u{1f200}\u{1f202}\u{1f210}-\u{1f219}\u{1f21b}-\u{1f22e}\u{1f230}\u{1f231}\u{1f237}\u{1f23b}\u{1f240}-\u{1f248}\u{1f260}-\u{1f265}\u{1f7da}\u{20000}-\u{2fffd}\u{30000}-\u{3fffd}]/u;

/**
 * Whether the CJK-friendly amendment reads `character`, one code point, as
 * CJK.
 */
export default function isCjkCharacter(character: string): boolean {
  return CJK.test(character);
}
