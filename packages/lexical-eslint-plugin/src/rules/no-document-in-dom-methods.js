/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @ts-check

/**
 * @typedef {import('eslint').Rule.RuleModule} RuleModule
 * @typedef {import('eslint').Rule.Node} Node
 */

const DOM_METHOD_NAMES = new Set([
  'createDOM',
  'updateDOM',
  'exportDOM',
  '$decorateDOM',
]);

/** @type {RuleModule} */
export const noDocumentInDomMethods = {
  create(context) {
    // Tracks nesting depth inside DOM method bodies. Does not reset at nested
    // function boundaries — acceptable since DOM methods don't define callbacks
    // that escape to non-editor contexts in practice.
    let depth = 0;

    /**
     * @param {Node} node
     * @returns {boolean}
     */
    function isDOMMethodNode(node) {
      return (
        (node.type === 'MethodDefinition' || node.type === 'Property') &&
        node.key.type === 'Identifier' &&
        DOM_METHOD_NAMES.has(node.key.name)
      );
    }

    /**
     * @param {Node} node
     */
    function enterMethod(node) {
      if (isDOMMethodNode(node)) {
        depth++;
      }
    }

    /**
     * @param {Node} node
     */
    function exitMethod(node) {
      if (isDOMMethodNode(node)) {
        depth--;
      }
    }

    return {
      MemberExpression(node) {
        if (
          depth > 0 &&
          node.object.type === 'Identifier' &&
          node.object.name === 'document'
        ) {
          context.report({
            fix(fixer) {
              return fixer.replaceText(node.object, '$getDocument()');
            },
            messageId: 'noDocumentInDomMethods',
            node: node.object,
          });
        }
      },
      MethodDefinition: enterMethod,
      'MethodDefinition:exit': exitMethod,
      Property: enterMethod,
      'Property:exit': exitMethod,
    };
  },
  meta: {
    docs: {
      description:
        'Disallow bare `document` global inside createDOM/updateDOM/exportDOM/$decorateDOM (class methods and object properties) and provide an autofix to $getDocument()',
      recommended: true,
      url: 'https://lexical.dev/docs/concepts/shadow-dom',
    },
    fixable: 'code',
    messages: {
      noDocumentInDomMethods:
        'Use $getDocument() instead of `document` inside DOM methods for Shadow DOM / iframe safety. Note: autofix replaces the identifier but does not add the import.',
    },
    schema: [],
    type: 'problem',
  },
};
