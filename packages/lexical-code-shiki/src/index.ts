/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

export {
  type CodeShikiConfig,
  CodeShikiExtension,
  registerCodeHighlighting,
  ShikiTokenizer,
  type Tokenizer,
} from './CodeHighlighterShiki';
export {
  getCodeLanguageOptions,
  getCodeThemeOptions,
  isCodeLanguageLoaded,
  loadCodeLanguage,
  loadCodeTheme,
  normalizeCodeLanguage,
} from './FacadeShiki';
