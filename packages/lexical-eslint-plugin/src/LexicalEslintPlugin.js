/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @ts-check

import {noDocumentInDomMethods} from './rules/no-document-in-dom-methods.js';
import {noNestedEditorUpdates} from './rules/no-nested-editor-updates.js';
import {rulesOfLexical} from './rules/rules-of-lexical.js';
import {SOURCE_VERSION} from './version.js';

/**
 * @typedef {import('eslint').Rule.RuleModule} RuleModule
 * @typedef {{plugins: {'@lexical': Plugin}; rules: {'@lexical/rules-of-lexical': 'warn' | 'error' | 'off'}}} FlatConfig
 * @typedef {{meta: {name: string; version: string}; rules: Rules; configs: Configs}} Plugin
 * @typedef {{'no-document-in-dom-methods': RuleModule; 'no-nested-editor-updates': RuleModule; 'rules-of-lexical': RuleModule}} Rules
 * @typedef {{all: FlatConfig; recommended: FlatConfig; 'flat/all': FlatConfig; 'flat/recommended': FlatConfig}} Configs
 */

// The plugin is assembled in functions declared free of side effects (and
// called once each at module scope) rather than by statements at module
// scope: a bundler keeps every module-scope property read and mutation, and
// the build annotates these calls so that a bare import of this module
// retains nothing.

/**
 * @returns {{name: string; version: string}}
 *
 * @__NO_SIDE_EFFECTS__
 */
function createMeta() {
  // The build replaces process.env.LEXICAL_VERSION with a literal such as
  // '0.50.0+prod.esm'; the build metadata is dropped so that `meta.version`
  // is the package version, as it was when it was read from package.json.
  const version = process.env.LEXICAL_VERSION ?? SOURCE_VERSION;
  // Not one string literal: the www build rewrites the quoted npm names of
  // the packages to their www module names (scripts/build.mjs), and
  // `meta.name` is the npm name there too.
  const name = ['@lexical', 'eslint-plugin'].join('/');
  return {name, version: version.replace(/\+.*$/, '')};
}

/**
 * @param {Plugin['meta']} pluginMeta
 * @param {Rules} pluginRules
 * @returns {Configs}
 *
 * @__NO_SIDE_EFFECTS__
 */
function createConfigs(pluginMeta, pluginRules) {
  // The flat configs reference the plugin, and the plugin carries the
  // configs, so the object the flat configs point at is created here with
  // the same rules, meta, and (once built) configs as the default export.
  /** @type {Plugin} */
  const plugin = {
    configs: /** @type {Configs} */ ({}),
    meta: pluginMeta,
    rules: pluginRules,
  };
  /** @type {FlatConfig} */
  const flatAll = {
    plugins: {
      '@lexical': plugin,
    },
    rules: {
      '@lexical/rules-of-lexical': 'warn',
    },
  };
  // Flat configs (ESLint 9+). `flat/all` and `flat/recommended` are the
  // names from when `all` and `recommended` were the legacy (ESLint 7-8)
  // configs, kept as aliases.
  /** @type {Configs} */
  const pluginConfigs = {
    all: flatAll,
    'flat/all': flatAll,
    'flat/recommended': flatAll,
    recommended: flatAll,
  };
  plugin.configs = pluginConfigs;
  return pluginConfigs;
}

export const meta = createMeta();

/** @type {Rules} */
export const rules = {
  'no-document-in-dom-methods': noDocumentInDomMethods,
  'no-nested-editor-updates': noNestedEditorUpdates,
  'rules-of-lexical': rulesOfLexical,
};

export const configs = createConfigs(meta, rules);

/** @type {Plugin} */
const plugin = {configs, meta, rules};

export default plugin;
