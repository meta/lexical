/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * For bootstrapping reasons, the plugin itself is written in plain JavaScript
 * (ES modules) so no compilation is necessary to use it from this checkout.
 */

import type {Rule} from 'eslint';

import jsPlugin from './LexicalEslintPlugin.js';

export type {NoNestedEditorUpdatesOptions} from './rules/no-nested-editor-updates.js';
export type {RulesOfLexicalOptions} from './rules/rules-of-lexical.js';

// Flat config format (ESLint 9+)
export interface FlatConfig {
  plugins: {
    '@lexical': Plugin;
  };
  rules: {
    '@lexical/rules-of-lexical': 'warn' | 'error' | 'off';
  };
}

export interface Plugin {
  meta: {
    name: string;
    version: string;
  };
  rules: {
    'no-document-in-dom-methods': Rule.RuleModule;
    'no-nested-editor-updates': Rule.RuleModule;
    'rules-of-lexical': Rule.RuleModule;
  };
  configs: {
    all: FlatConfig;
    recommended: FlatConfig;
    // Aliases from when `all` and `recommended` were the legacy configs
    'flat/all': FlatConfig;
    'flat/recommended': FlatConfig;
  };
}

const plugin: Plugin = jsPlugin;

// Named exports so that a CommonJS consumer can use what require() returns
// from the ESM build as the plugin: require(esm) hands back the module
// namespace, which ESLint accepts as a plugin as long as `rules`, `configs`,
// and `meta` are named exports on it.
export {configs, meta, rules} from './LexicalEslintPlugin.js';

// eslint-disable-next-line no-restricted-exports
export default plugin;
