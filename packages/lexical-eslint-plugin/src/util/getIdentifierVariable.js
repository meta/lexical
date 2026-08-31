/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @ts-check

/**
 * @typedef {import('eslint').Rule.NodeParentExtension} NodeParentExtension
 * @typedef {import('estree').Identifier & NodeParentExtension} Identifier
 * @typedef {import('eslint').SourceCode} SourceCode
 */

/**
 * Find the variable associated with the given Identifier.
 *
 * @param {SourceCode} sourceCode
 * @param {Identifier} identifier
 */
function getIdentifierVariable(sourceCode, identifier) {
  const scopeManager = sourceCode.scopeManager;
  for (const scope of scopeManager.scopes) {
    for (const variable of scope.variables) {
      if (
        variable.identifiers.includes(identifier) ||
        variable.references.some(
          reference => reference.identifier === identifier,
        )
      ) {
        return variable;
      }
    }
  }
  return undefined;
}

module.exports = {getIdentifierVariable};
