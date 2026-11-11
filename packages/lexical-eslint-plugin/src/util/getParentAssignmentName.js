/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @ts-check
'use strict';

/**
 * Gets the static name of an AST node's parent, used to determine the name of an
 * anonymous function declaration, possibly through a higher order function call.
 * This was extracted from the body of getFunctionName so it could also be used
 * in the context of `useCallback` or `useMemo`, e.g.
 * `const $fun = useCallback(() => {}, [])` where the name is not the direct
 * parent of the anonymous function.
 *
 * @param {import('eslint').Rule.Node} node
 */
export function getParentAssignmentName(node) {
  // Unlike React's rules of hooks, this does not check property assignment.
  // The rules of lexical $function convention only applies to functions,
  // not methods or properties.
  const parentNode = node.parent;
  if (parentNode == null) {
    return undefined;
  }
  if (parentNode.type === 'VariableDeclarator' && parentNode.init === node) {
    // const $function = () => {};
    return parentNode.id;
  } else if (
    parentNode.type === 'AssignmentExpression' &&
    parentNode.right === node &&
    parentNode.operator === '='
  ) {
    // $function = () => {};
    return parentNode.left;
  } else {
    return undefined;
  }
}
