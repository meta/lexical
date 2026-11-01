/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * @typedef {import('estree').Node} Node
 * @typedef {import('estree').Identifier} Identifier
 * @typedef {(name: string, node: Identifier) => boolean} NameIdentifierMatcher
 * @typedef {NameIdentifierMatcher | string | RegExp | undefined} ToMatcher
 * @typedef {(node: Identifier | undefined) => boolean} IdentifierMatcher
 */

/**
 * Escape a string for exact match in a RegExp
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions#escaping
 *
 * @param {string} string
 * @returns {string}
 */
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

/**
 * Build an Identifier Node Matcher from the given ToMatcher arguments.
 * The Matcher is roughly equivalent to building RegExp from all of the
 * sources and or-ing them together. String arguments are treated as
 * RegExp sources and will be escaped with an implicit '^...$' wrapper
 * unless it starts with a '(' or '^'
 *
 * @param {(ToMatcher | ToMatcher[])[]} args
 * @returns {IdentifierMatcher}
 */
export function buildMatcher(...toMatchers) {
  /** @type {Matcher[]} */
  const matchFuns = [];
  /** @type {string[]} */
  const regExpSources = [];
  for (const arg of toMatchers.flat(1)) {
    if (!arg) {
      continue;
    } else if (typeof arg === 'string') {
      regExpSources.push(/^[(^]/.test(arg) ? arg : `^${escapeRegExp(arg)}$`);
    } else if (arg && arg instanceof RegExp) {
      if (arg.flags) {
        matchFuns.push(s => arg.test(s));
      } else {
        regExpSources.push(arg.source);
      }
    } else if (typeof arg === 'function') {
      matchFuns.push(arg);
    }
  }
  const pattern = regExpSources.map(s => `(?:${s})`).join('|');
  if (pattern) {
    const re = new RegExp(pattern);
    matchFuns.push(s => re.test(s));
  }
  return node => {
    if (node) {
      if (node.type !== 'Identifier') {
        // Runtime type invariant check
        throw new Error(`Expecting Identifier, not ${node.type}`);
      }
      for (const matcher of matchFuns) {
        if (matcher(node.name, node)) {
          return true;
        }
      }
    }
    return false;
  };
}
