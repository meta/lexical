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
 * @typedef {import('estree').CallExpression} CallExpression
 * @typedef {import('estree').ObjectExpression} ObjectExpression
 * @typedef {import('estree').Node} EstreeNode
 */

/**
 * The name of a property key that is an identifier or a string literal, or
 * null for a computed key.
 *
 * @param {import('estree').Property} property
 * @returns {string | null}
 */
function keyName(property) {
  if (property.computed) {
    return null;
  }
  const {key} = property;
  if (key.type === 'Identifier') {
    return key.name;
  }
  if (key.type === 'Literal' && typeof key.value === 'string') {
    return key.value;
  }
  return null;
}

/**
 * Whether `node` names `name`: `name` or `anything.name`.
 *
 * @param {EstreeNode} node
 * @param {string} name
 * @returns {boolean}
 */
function names(node, name) {
  return (
    (node.type === 'Identifier' && node.name === name) ||
    (node.type === 'MemberExpression' &&
      !node.computed &&
      node.property.type === 'Identifier' &&
      node.property.name === name)
  );
}

/** @type {RuleModule} */
export const yCollabStatus = {
  create(context) {
    return {
      /** @param {CallExpression & import('eslint').Rule.NodeParentExtension} node */
      CallExpression(node) {
        const [extension, config] = node.arguments;
        if (
          !names(node.callee, 'configExtension') ||
          extension === undefined ||
          extension.type === 'SpreadElement' ||
          !names(extension, 'YCollabExtension') ||
          config === undefined ||
          config.type !== 'ObjectExpression'
        ) {
          return;
        }
        const keys = new Set();
        for (const property of config.properties) {
          if (property.type === 'SpreadElement') {
            // What the spread holds is not known here.
            return;
          }
          const name = keyName(property);
          if (name === null) {
            return;
          }
          keys.add(name);
        }
        // A config without `doc` overrides another dependency's (yCollab,
        // createYCollabConfig), which brings its own onYStatus.
        if (!keys.has('doc') || keys.has('onYStatus')) {
          return;
        }
        const last = config.properties[config.properties.length - 1];
        context.report({
          messageId: 'missingOnYStatus',
          node: config,
          suggest: [
            {
              fix(fixer) {
                return fixer.insertTextAfter(last, ', onYStatus: null');
              },
              messageId: 'addNull',
            },
          ],
        });
      },
    };
  },
  meta: {
    docs: {
      description:
        'Require `onYStatus` in `configExtension(YCollabExtension, {doc, ...})`: the type cannot (an extension config is partial), and the editor throws when it is built without it',
      recommended: true,
      url: 'https://lexical.dev/docs/collaboration/y',
    },
    hasSuggestions: true,
    messages: {
      addNull:
        'Add `onYStatus: null` (the app reads the status from the yStatus output or binding.status)',
      missingOnYStatus:
        "configExtension(YCollabExtension, {doc, ...}) needs onYStatus: a function that shows the user why the document is read only, or null when the app reads the status another way (the extension's yStatus output, binding.status). Without it the editor throws when it is built.",
    },
    schema: [],
    type: 'problem',
  },
};
