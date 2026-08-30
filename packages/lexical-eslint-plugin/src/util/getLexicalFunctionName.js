/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @ts-check

const {getFunctionName} = require('./getFunctionName.js');
const {getParentAssignmentName} = require('./getParentAssignmentName.js');

/**
 * @typedef {import('eslint').Rule.Node} Node
 * @typedef {import('eslint').Rule.NodeParentExtension} NodeParentExtension
 * @typedef {import('estree').Identifier & NodeParentExtension} Identifier
 */

/**
 * Hook functions start with use followed by a capital latin letter.
 *
 * @param {Node | undefined} node
 */
function isHookFunctionIdentifier(node) {
  return node && node.type === 'Identifier' && /^use([A-Z]|$)/.test(node.name);
}

/**
 * Return this node if it is an Identifier, otherwise if it is a
 * MemberExpression such as `editor.read`, return the Identifier of its
 * property (`read` in this case).
 *
 * @param {Node | undefined} node
 * @returns {Identifier | undefined}
 */
function getFunctionNameIdentifier(node) {
  if (!node) {
    return;
  } else if (node.type === 'Identifier') {
    return node;
  } else if (node.type === 'MemberExpression' && !node.computed) {
    return getFunctionNameIdentifier(/** @type {Node} */ (node.property));
  }
}

/**
 * Get the function's name, or if it is defined with a hook (for example,
 * useMemo or useCallback), get the name of the variable the result is
 * assigned to.
 *
 * @param {Node} node
 */
function getLexicalFunctionName(node) {
  const name = getFunctionName(node);
  if (name) {
    return /** @type {Identifier} */ (name);
  }
  const nodeParent = node.parent;
  if (
    nodeParent != null &&
    nodeParent.type === 'CallExpression' &&
    nodeParent.arguments[0] === node
  ) {
    const parentName = getFunctionNameIdentifier(
      /** @type {Node} */ (nodeParent.callee),
    );
    if (isHookFunctionIdentifier(parentName)) {
      return /** @type {Identifier | undefined} */ (
        getParentAssignmentName(/** @type {Node} */ (nodeParent))
      );
    }
  }
}

module.exports = {getFunctionNameIdentifier, getLexicalFunctionName};
