/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @ts-check

/**
 * @typedef {import('eslint').Rule.RuleContext} RuleContext
 * @typedef {import('../util/buildMatcher.js').ToMatcher} ToMatcher
 */

const DEFAULT_DOLLAR_FUNCTION_MATCHER = /^\$[a-z_]/;

/**
 * @param {RuleContext} context
 * @param {string} optionName
 * @returns {ToMatcher}
 */
function parseMatcherOption(context, optionName) {
  const options = Array.isArray(context.options)
    ? context.options[0]
    : undefined;
  return options && optionName in options ? options[optionName] : undefined;
}

/** @param {RuleContext} context */
function getSourceCode(context) {
  if (context.sourceCode) {
    return context.sourceCode;
  }
  // @ts-expect-error -- getSourceCode() removed from types in ESLint 10, kept for ESLint 8 compat
  return context.getSourceCode();
}

const matcherSchema = {
  oneOf: [{type: 'string'}, {contains: {type: 'string'}, type: 'array'}],
};

module.exports = {
  DEFAULT_DOLLAR_FUNCTION_MATCHER,
  getSourceCode,
  matcherSchema,
  parseMatcherOption,
};
