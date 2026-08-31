/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @ts-check

const {buildMatcher} = require('../util/buildMatcher.js');
const {getIdentifierVariable} = require('../util/getIdentifierVariable.js');
const {
  getFunctionNameIdentifier,
  getLexicalFunctionName,
} = require('../util/getLexicalFunctionName.js');
const {
  DEFAULT_DOLLAR_FUNCTION_MATCHER,
  getSourceCode,
  matcherSchema,
  parseMatcherOption,
} = require('../util/ruleOptions.js');

/**
 * @typedef {import('eslint').Rule.NodeParentExtension} NodeParentExtension
 * @typedef {import('estree').CallExpression & NodeParentExtension} CallExpression
 * @typedef {import('estree').Identifier & NodeParentExtension} Identifier
 * @typedef {import('eslint').Rule.Node} Node
 * @typedef {import('eslint').Rule.RuleContext} RuleContext
 * @typedef {import('eslint').Rule.RuleModule} RuleModule
 * @typedef {import('eslint').SourceCode} SourceCode
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
  isDollarFunction: [DEFAULT_DOLLAR_FUNCTION_MATCHER],
  isEditor: [/editor$/i],
};

/**
 * In a $function, only these receiver names are assumed to refer to the active
 * editor. Broader names such as `childEditor` may intentionally refer to a
 * different editor.
 */
const CurrentEditorBaseMatchers = ['editor', '$getEditor'];

/**
 * @typedef {Partial<BaseMatchers<ToMatcher | ToMatcher[]>>} NoNestedEditorUpdatesOptions
 * @typedef {BaseMatchers<IdentifierMatcher> & {isCurrentEditor: IdentifierMatcher}} Matchers
 * @typedef {{method: Identifier, receiver: Node}} EditorMethod
 * @typedef {{kind: 'dollarFunction', name: string} | {kind: 'editorCallback', name: string, receiver: Node}} UpdateContext
 */

const implicitUpdateCallbackIndex = new Map([
  ['read', 0],
  ['registerCommand', 1],
  ['registerNodeTransform', 1],
  ['update', 0],
]);

/**
 * @param {RuleContext} context
 * @returns {Matchers}
 */
function compileMatchers(context) {
  const isEditorOption = parseMatcherOption(context, 'isEditor');
  return {
    isCurrentEditor: buildMatcher(CurrentEditorBaseMatchers, isEditorOption),
    isDollarFunction: buildMatcher(
      BaseMatchers.isDollarFunction,
      parseMatcherOption(context, 'isDollarFunction'),
    ),
    isEditor: buildMatcher(BaseMatchers.isEditor, isEditorOption),
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
 * @returns {EditorMethod | undefined}
 */
function getEditorMethod(node, matchers) {
  const callee = node.callee;
  if (callee.type !== 'MemberExpression' || callee.computed) {
    return;
  }
  const method = getFunctionNameIdentifier(
    /** @type {Node} */ (callee.property),
  );
  const receiver = /** @type {Node} */ (callee.object);
  const editor = getExpressionNameIdentifier(receiver);
  return method && matchers.isEditor(editor) ? {method, receiver} : undefined;
}

/**
 * @param {Node} node
 * @returns {Node}
 */
function unwrapChainExpression(node) {
  return node.type === 'ChainExpression'
    ? /** @type {Node} */ (node.expression)
    : node;
}

/**
 * Compare identifier bindings rather than names so a shadowed `editor`
 * variable is not treated as the receiver of the outer update.
 *
 * @param {SourceCode} sourceCode
 * @param {Identifier} left
 * @param {Identifier} right
 */
function isSameIdentifier(sourceCode, left, right) {
  if (left.name !== right.name) {
    return false;
  }
  const leftVariable = getIdentifierVariable(sourceCode, left);
  const rightVariable = getIdentifierVariable(sourceCode, right);
  return leftVariable || rightVariable
    ? leftVariable != null && leftVariable === rightVariable
    : true;
}

/**
 * Return true only when two receiver expressions can be statically tied to
 * the same editor. Aliases and arbitrary getter calls are intentionally out of
 * scope because a false positive can recommend a behavior-changing rewrite.
 *
 * @param {SourceCode} sourceCode
 * @param {Node} leftNode
 * @param {Node} rightNode
 */
function isSameEditorExpression(sourceCode, leftNode, rightNode) {
  const left = unwrapChainExpression(leftNode);
  const right = unwrapChainExpression(rightNode);
  if (left.type !== right.type) {
    return false;
  }
  if (left.type === 'Identifier' && right.type === 'Identifier') {
    return isSameIdentifier(
      sourceCode,
      /** @type {Identifier} */ (left),
      /** @type {Identifier} */ (right),
    );
  }
  if (
    left.type === 'MemberExpression' &&
    right.type === 'MemberExpression' &&
    !left.computed &&
    !right.computed &&
    left.property.type === 'Identifier' &&
    right.property.type === 'Identifier' &&
    left.property.name === right.property.name
  ) {
    return isSameEditorExpression(
      sourceCode,
      /** @type {Node} */ (left.object),
      /** @type {Node} */ (right.object),
    );
  }
  if (
    left.type === 'CallExpression' &&
    right.type === 'CallExpression' &&
    left.arguments.length === 0 &&
    right.arguments.length === 0
  ) {
    const leftName = getFunctionNameIdentifier(
      /** @type {Node} */ (left.callee),
    );
    const rightName = getFunctionNameIdentifier(
      /** @type {Node} */ (right.callee),
    );
    return (
      leftName != null &&
      rightName != null &&
      leftName.name === '$getEditor' &&
      isSameIdentifier(sourceCode, leftName, rightName)
    );
  }
  return false;
}

/**
 * @param {Node} node
 * @param {Matchers} matchers
 */
function isCurrentEditorInDollarFunction(node, matchers) {
  const expression = unwrapChainExpression(node);
  if (expression.type === 'Identifier') {
    return matchers.isCurrentEditor(/** @type {Identifier} */ (expression));
  }
  if (
    expression.type === 'CallExpression' &&
    expression.arguments.length === 0
  ) {
    return matchers.isCurrentEditor(
      getFunctionNameIdentifier(/** @type {Node} */ (expression.callee)),
    );
  }
  return false;
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
 * @returns {UpdateContext | undefined}
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
    return {kind: 'dollarFunction', name: functionNameIdentifier.name};
  }

  const parent = node.parent;
  if (parent == null || parent.type !== 'CallExpression') {
    return;
  }
  const editorMethod = getEditorMethod(
    /** @type {CallExpression} */ (parent),
    matchers,
  );
  if (!editorMethod) {
    return;
  }
  const callbackIndex = implicitUpdateCallbackIndex.get(
    editorMethod.method.name,
  );
  if (callbackIndex == null || parent.arguments[callbackIndex] !== node) {
    return;
  }
  const editorName = getExpressionNameIdentifier(editorMethod.receiver);
  return editorName
    ? {
        kind: 'editorCallback',
        name: `${editorName.name}.${editorMethod.method.name} callback`,
        receiver: editorMethod.receiver,
      }
    : undefined;
}

/** @type {RuleModule} */
module.exports.noNestedEditorUpdates = {
  create(context) {
    const matchers = compileMatchers(context);
    const sourceCode = getSourceCode(context);

    return {
      CallExpression: node => {
        const callExpression = /** @type {CallExpression} */ (node);
        const editorMethod = getEditorMethod(callExpression, matchers);
        if (!editorMethod || editorMethod.method.name !== 'update') {
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
        const data = {
          callee: sourceCode.getText(callExpression.callee),
          context: updateContext.name,
        };
        if (updateContext.kind === 'dollarFunction') {
          if (
            isCurrentEditorInDollarFunction(editorMethod.receiver, matchers)
          ) {
            context.report({
              data,
              messageId: 'dollarFunctionUpdate',
              node: callExpression.callee,
            });
          }
        } else if (
          isSameEditorExpression(
            sourceCode,
            updateContext.receiver,
            editorMethod.receiver,
          )
        ) {
          context.report({
            data,
            messageId: 'noNestedEditorUpdates',
            node: callExpression.callee,
          });
        }
      },
    };
  },
  meta: {
    docs: {
      description: 'disallows redundant same-editor updates',
      recommended: false,
      url: 'https://lexical.dev/docs/packages/lexical-eslint-plugin',
    },
    messages: {
      dollarFunctionUpdate:
        '{{context}} is named as a Lexical $function but calls {{callee}}. Remove the update wrapper, or remove the $ prefix if this function intentionally starts the update.',
      noNestedEditorUpdates:
        '{{context}} already provides an update context for this editor. Remove the nested {{callee}} wrapper.',
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
