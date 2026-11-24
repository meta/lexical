/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * A node's type names its exact class: a subclass, or a node replacement
 * registered with `withKlass`, has a type of its own, so
 * `node.getType() === 'code'` is false for nodes that `$isCodeNode(node)`
 * accepts. This reports `===`, `!==`, `==` and `!=` between `x.getType()`
 * and a string or `SomeNode.getType()`, except for the root's type, since
 * RootNode cannot be subclassed or replaced. Code that means exactly one
 * class says so in a disable comment.
 */

const EQUALITY = new Set(['===', '!==', '==', '!=']);

/**
 * @param {any} node
 * @returns {any} the object of `x.getType()` or `x?.getType()`, else null
 */
function getTypeReceiver(node) {
  const n = node.type === 'ChainExpression' ? node.expression : node;
  return n.type === 'CallExpression' &&
    n.arguments.length === 0 &&
    n.callee.type === 'MemberExpression' &&
    !n.callee.computed &&
    n.callee.property.type === 'Identifier' &&
    n.callee.property.name === 'getType'
    ? n.callee.object
    : null;
}

/**
 * @param {any} node
 * @returns {string | null} K for `K.getType()` with a capitalized K
 */
function className(node) {
  const object = getTypeReceiver(node);
  return object !== null &&
    object.type === 'Identifier' &&
    /^[A-Z]/.test(object.name)
    ? object.name
    : null;
}

/**
 * @param {any} node
 * @returns {string | null} the type that node names, if it is a constant
 */
function constantType(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  const name = className(node);
  return name === null ? null : name === 'RootNode' ? 'root' : name;
}

/**
 * @param {any} node
 * @returns {boolean} whether node is a node's `getType()`, not a class's
 */
function isNodeType(node) {
  return getTypeReceiver(node) !== null && className(node) === null;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  create(context) {
    return {
      BinaryExpression(node) {
        if (!EQUALITY.has(node.operator)) {
          return;
        }
        const constant = isNodeType(node.left)
          ? constantType(node.right)
          : isNodeType(node.right)
            ? constantType(node.left)
            : null;
        if (constant !== null && constant !== 'root') {
          context.report({messageId: 'comparison', node});
        }
      },
    };
  },
  meta: {
    docs: {
      description: "disallow comparing a node's getType() with a constant type",
      recommended: false,
    },
    messages: {
      comparison:
        "A node's type matches only its exact class: a subclass or node replacement has a type of its own. Use the $isXNode guard or instanceof, or disable this rule with a reason where the exact class is meant.",
    },
    schema: [],
    type: 'problem',
  },
};
