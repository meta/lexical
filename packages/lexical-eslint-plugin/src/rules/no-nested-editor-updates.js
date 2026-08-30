/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @ts-check

const {buildMatcher} = require('../util/buildMatcher.js');
const {
  getFunctionNameIdentifier,
  getLexicalFunctionName,
} = require('../util/getLexicalFunctionName.js');

/**
 * @typedef {import('eslint').Rule.NodeParentExtension} NodeParentExtension
 * @typedef {import('estree').CallExpression & NodeParentExtension} CallExpression
 * @typedef {import('estree').Identifier & NodeParentExtension} Identifier
 * @typedef {import('eslint').Rule.Node} Node
 * @typedef {import('eslint').Rule.RuleContext} RuleContext
 * @typedef {import('eslint').Rule.RuleModule} RuleModule
 * @typedef {import('../util/buildMatcher.js').ToMatcher} ToMatcher
 * @typedef {import('../util/buildMatcher.js').IdentifierMatcher} IdentifierMatcher
 */

/**
 * @template T
 * @typedef {Object} BaseMatchers
 * @property {T} isDollarFunction Identifies functions that require a Lexical editor context.
 * @property {T} isEditor Identifies expressions that refer to a Lexical editor.
 */

/** @type {BaseMatchers<Exclude<ToMatcher, undefined>[]>} */
const BaseMatchers = {
  isDollarFunction: [/^\$[a-z_]/],
  isEditor: [/editor$/i],
};

/**
 * @typedef {Partial<BaseMatchers<ToMatcher | ToMatcher[]>>} NoNestedEditorUpdatesOptions
 * @typedef {BaseMatchers<IdentifierMatcher>} Matchers
 */

const implicitUpdateCallbackIndex = new Map([
  ['registerCommand', 1],
  ['registerNodeTransform', 1],
  ['update', 0],
]);

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

/**
 * @param {RuleContext} context
 * @returns {Matchers}
 */
function compileMatchers(context) {
  return {
    isDollarFunction: buildMatcher(
      BaseMatchers.isDollarFunction,
      parseMatcherOption(context, 'isDollarFunction'),
    ),
    isEditor: buildMatcher(
      BaseMatchers.isEditor,
      parseMatcherOption(context, 'isEditor'),
    ),
  };
}

/**
 * Return an Identifier that describes an expression's value. This supports
 * common editor expressions such as `editor`, `props.editor`, and
 * `$getEditor()` without treating every object with an `update` method as a
 * Lexical editor.
 *
 * @param {Node} node
 * @returns {Identifier | undefined}
 */
function getExpressionNameIdentifier(node) {
  if (node.type === 'Identifier') {
    return node;
  } else if (node.type === 'CallExpression') {
    return getFunctionNameIdentifier(/** @type {Node} */ (node.callee));
  } else if (node.type === 'MemberExpression' && !node.computed) {
    return getFunctionNameIdentifier(/** @type {Node} */ (node.property));
  } else if (node.type === 'ChainExpression') {
    return getExpressionNameIdentifier(/** @type {Node} */ (node.expression));
  }
}

/**
 * @param {CallExpression} node
 * @param {Matchers} matchers
 */
function getEditorMethod(node, matchers) {
  const callee = node.callee;
  if (callee.type !== 'MemberExpression' || callee.computed) {
    return;
  }
  const method = getFunctionNameIdentifier(
    /** @type {Node} */ (callee.property),
  );
  const editor = getExpressionNameIdentifier(
    /** @type {Node} */ (callee.object),
  );
  return method && matchers.isEditor(editor) ? method : undefined;
}

/**
 * @param {Node} node
 */
function getEnclosingFunction(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      parent.type === 'ArrowFunctionExpression' ||
      parent.type === 'FunctionDeclaration' ||
      parent.type === 'FunctionExpression'
    ) {
      return parent;
    }
  }
}

/**
 * @param {Node} node
 * @param {Matchers} matchers
 * @returns {string | undefined}
 */
function getImplicitUpdateContext(node, matchers) {
  const functionName = getLexicalFunctionName(node);
  const functionNameIdentifier = getFunctionNameIdentifier(
    /** @type {Node | undefined} */ (functionName),
  );
  if (
    functionNameIdentifier &&
    matchers.isDollarFunction(functionNameIdentifier)
  ) {
    return functionNameIdentifier.name;
  }

  const parent = node.parent;
  if (parent == null || parent.type !== 'CallExpression') {
    return;
  }
  const method = getEditorMethod(
    /** @type {CallExpression} */ (parent),
    matchers,
  );
  if (!method) {
    return;
  }
  const callbackIndex = implicitUpdateCallbackIndex.get(method.name);
  if (callbackIndex == null || parent.arguments[callbackIndex] !== node) {
    return;
  }
  const editorName = getExpressionNameIdentifier(
    /** @type {Node} */ (
      /** @type {import('estree').MemberExpression} */ (parent.callee).object
    ),
  );
  return editorName ? `${editorName.name}.${method.name} callback` : undefined;
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

/** @type {RuleModule} */
module.exports.noNestedEditorUpdates = {
  create(context) {
    const matchers = compileMatchers(context);
    const sourceCode = getSourceCode(context);

    return {
      CallExpression: node => {
        const callExpression = /** @type {CallExpression} */ (node);
        const method = getEditorMethod(callExpression, matchers);
        if (!method || method.name !== 'update') {
          return;
        }
        const enclosingFunction = getEnclosingFunction(node);
        if (!enclosingFunction) {
          return;
        }
        const updateContext = getImplicitUpdateContext(
          enclosingFunction,
          matchers,
        );
        if (!updateContext) {
          return;
        }
        context.report({
          data: {
            callee: sourceCode.getText(callExpression.callee),
            context: updateContext,
          },
          messageId: 'noNestedEditorUpdates',
          node: callExpression.callee,
        });
      },
    };
  },
  meta: {
    docs: {
      description: 'disallows nested editor updates',
      recommended: false,
      url: 'https://lexical.dev/docs/packages/lexical-eslint-plugin',
    },
    messages: {
      noNestedEditorUpdates:
        '{{context}} already provides or requires a Lexical editor context. Remove the nested {{callee}} wrapper.',
    },
    schema: [
      {
        additionalProperties: false,
        properties: {
          isDollarFunction: matcherSchema,
          isEditor: matcherSchema,
        },
        type: 'object',
      },
    ],
    type: 'problem',
  },
};
