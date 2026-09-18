/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import noImportsFromSelf from './rules/no-imports-from-self.js';
import noOptionalChaining from './rules/no-optional-chaining.js';
import noPureAnnotation from './rules/no-pure-annotation.js';

const rules = {
  'no-imports-from-self': noImportsFromSelf,
  'no-optional-chaining': noOptionalChaining,
  'no-pure-annotation': noPureAnnotation,
};

// Legacy config format (ESLint 7-8)
// Note: no-pure-annotation is deliberately not part of the default configs —
// it is about how this repository builds its own sources, so the root
// eslint.config.mjs enables it with its own files scope.
const legacyAll = {
  rules: {
    '@lexical/internal/no-imports-from-self': 'error',
    '@lexical/internal/no-optional-chaining': 'error',
  },
};

const plugin = {
  configs: {
    // Legacy configs (ESLint 7-8) - available under multiple names for compatibility
    all: legacyAll,
    // Flat configs (ESLint 9-10+) - placeholders, will be set below
    'flat/all': /** @type {any} */ (null),
    'flat/recommended': /** @type {any} */ (null),
    'legacy-all': legacyAll,
    'legacy-recommended': legacyAll,
    recommended: legacyAll,
  },
  rules,
};

// Flat config format (ESLint 9-10+)
// Must be created after plugin is defined to avoid circular reference
const flatAll = {
  plugins: {
    '@lexical/internal': plugin,
  },
  rules: {
    '@lexical/internal/no-imports-from-self': 'error',
    '@lexical/internal/no-optional-chaining': 'error',
  },
};

plugin.configs['flat/all'] = flatAll;
plugin.configs['flat/recommended'] = flatAll;

export default plugin;
