/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @ts-check

import {buildMatcher} from '../util/buildMatcher.js';
import {getFunctionName} from '../util/getFunctionName.js';
import {getParentAssignmentName} from '../util/getParentAssignmentName.js';

/**
 * @typedef {import('eslint').Rule.NodeParentExtension} NodeParentExtension
 * @typedef {import('estree').CallExpression & NodeParentExtension} CallExpression
 * @typedef {import('estree').Identifier & NodeParentExtension} Identifier
 * @typedef {import('eslint').Rule.RuleContext} RuleContext
 * @typedef {import('eslint').Rule.Fix} Fix
 * @typedef {import('eslint').Rule.Node} Node
 * @typedef {import('eslint').Rule.RuleModule} RuleModule
 * @typedef {import('eslint').Rule.ReportFixer} ReportFixer
 * @typedef {import('eslint').SourceCode} SourceCode
 * @typedef {import('eslint').Scope.Variable} Variable
 * @typedef {import('eslint').Scope.Scope} Scope
 */

/**
 * Find the variable associated with the given Identifier
 *
 * @param {SourceCode} sourceCode
 * @param {Identifier} identifier
 */
function getIdentifierVariable(sourceCode, identifier) {
  const scopeManager = sourceCode.scopeManager;
  for (
    let node = /** @type {Node | null} */ (identifier);
    node;
    node = /** @type {Node | null}*/ (node.parent)
  ) {
    const variable = scopeManager
      .getDeclaredVariables(node)
      .find(v => v.identifiers.includes(identifier));
    if (variable) {
      return variable;
    }
    const scope = scopeManager.acquire(node);
    if (scope) {
      return (
        scope.set.get(identifier.name) ||
        (scope.upper ? scope.upper.set.get(identifier.name) : undefined)
      );
    }
  }
  return undefined;
}

/**
 * @typedef {import('../util/buildMatcher.js').ToMatcher} ToMatcher
 * @typedef {import('../util/buildMatcher.js').IdentifierMatcher} IdentifierMatcher
 */

/**
 * @template T
 * @typedef {Object} BaseMatchers<T>
 * @property {T} isDollarFunction Catch all identifiers that begin with '$' or 'INTERNAL_$' followed by a lowercase Latin character or underscore
 * @property {T} isIgnoredFunction These functions may call any $functions even though they do not have the isDollarFunction naming convention
 * @property {T} isLexicalProvider Certain calls through the editor or editorState allow for implicit access to call $functions: read, registerCommand, registerNodeTransform, update.
 * @property {T} isSafeDollarFunction It's usually safe to call $isNode functions, so any '$is' or 'INTERNAL_$is' function may be called in any context.
 */

/** @type {BaseMatchers<Exclude<ToMatcher, undefined>[]>} */
const BaseMatchers = {
  isDollarFunction: [/^\$[a-z_]/],
  isIgnoredFunction: [],
  isLexicalProvider: [
    'parseEditorState',
    'read',
    'registerCommand',
    'registerNodeTransform',
    'update',
  ],
  isSafeDollarFunction: [/^\$is[A-Z_]/],
};

/**
 * @typedef {Partial<BaseMatchers<ToMatcher | ToMatcher[]>>} RulesOfLexicalOptions
 * @typedef {BaseMatchers<IdentifierMatcher>} Matchers
 */

/**
 * @param {RuleContext} context
 * @returns {Matchers}
 */
function compileMatchers(context) {
  const rval = /** @type {Matchers} */ ({});
  for (const k_ in BaseMatchers) {
    const k = /** @type {keyof Matchers} */ (k_);
    rval[k] = buildMatcher(BaseMatchers[k], parseMatcherOption(context, k));
  }
  return rval;
}

/**
 * Hook functions start with use followed by a capital latin letter.
 *
 * @param {Node | undefined} node
 */
function isHookFunctionIdentifier(node) {
  return node && node.type === 'Identifier' && /^use([A-Z]|$)/.test(node.name);
}

/**
 * Return this node if is an Identifier, otherwise if it is a MemberExpression such as
 * `editor.read` return the Identifier of its property ('read' in this case).
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
 * Get the function's name, or if it is defined with a hook
 * (e.g. useMemo, useCallback), then get the name of the variable the result
 * is assigned to.
 *
 * @param {Node} node
 */
function getLexicalFunctionName(node) {
  const name = getFunctionName(node);
  if (name) {
    return name;
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
      return getParentAssignmentName(/** @type {Node} */ (nodeParent));
    }
  }
}

/**
 * Return a name suitable for a suggestion.
 * isDollarFunction(getFirstSuggestion(name)) should
 * be true for any given name.
 *
 * @param {string} name
 * @returns {string}
 */
function getFirstSuggestion(name) {
  if (/^[a-z]/.test(name)) {
    return '$' + name;
  } else if (/^[A-Z][a-z]/.test(name)) {
    return '$' + name.slice(0, 1).toLowerCase() + name.slice(1);
  } else {
    return `$_${name}`;
  }
}

/**
 * Get the suggested name for a variable and add an underscore if it shadows
 * or conflicts with an existing variable.
 *
 * @param {Identifier} nameIdentifier
 * @param {Variable | undefined} variable
 */
function getSuggestName(nameIdentifier, variable) {
  const suggestName = getFirstSuggestion(nameIdentifier.name);
  // Add an underscore if this would shadow an existing name
  if (variable) {
    for (
      let scope = /** @type {Scope | null} */ (variable.scope);
      scope;
      scope = scope.upper
    ) {
      if (scope.set.has(suggestName)) {
        return suggestName + '_';
      }
    }
  }
  return suggestName;
}

/**
 * Get the export declaration for a variable, if it has one.
 *
 * @param {Variable | undefined} variable
 */
function getExportDeclaration(variable) {
  if (variable && variable.defs.length === 1) {
    const defNode = /** @type {Node} */ (variable.defs[0].node);
    const defParent = defNode.parent;
    if (defParent != null && defParent.type === 'ExportNamedDeclaration') {
      // export function foo();
      return defParent;
    } else if (
      defParent != null &&
      defParent.type === 'VariableDeclaration' &&
      defParent.parent != null &&
      defParent.parent.type === 'ExportNamedDeclaration'
    ) {
      // export const foo = () => {};
      return defParent.parent;
    }
  }
}

/**
 * The comment we insert when an export is renamed.
 *
 * @param {Record<'caller'|'suggestName', string>} data
 */
function renameExportText({caller, suggestName}) {
  return `\n/** @deprecated renamed to {@link ${suggestName}} by @lexical/eslint-plugin rules-of-lexical */\nexport const ${caller} = ${suggestName};`;
}

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

/** @type {RuleModule} */
export const rulesOfLexical = {
  create(context) {
    const sourceCode = getSourceCode(context);
    const matchers = compileMatchers(context);

    /**
     * When this set is non-empty it means that we are visiting a node
     * that should not be analyzed.
     *
     * @type {Set<Node>}
     */
    const ignoreSet = new Set();
    /**
     * The set of Identifier nodes that have been reported, we do not
     * want to report the same node more than once (a function making several
     * calls to $functions only needs to be renamed once!)
     *
     * @type {Set<Identifier>}
     */
    const reportedSet = new Set();
    /**
     * The current stack of functions
     *
     * @type {{ name?: Identifier, node: Node }[]} funStack
     */
    const funStack = [];
    const shouldIgnore = () => {
      if (ignoreSet.size > 0) {
        return true;
      }
      // Ignore property assignments
      const lastFunction = funStack[funStack.length - 1];
      return (
        lastFunction &&
        lastFunction.node.parent != null &&
        lastFunction.node.parent.type === 'Property'
      );
    };
    const pushIgnoredNode = (/** @type {Node} */ node) => ignoreSet.add(node);
    const popIgnoredNode = (/** @type {Node} */ node) => ignoreSet.delete(node);
    const pushFunction = (/** @type {Node} */ node) => {
      const name = getFunctionNameIdentifier(
        /** @type {Node | undefined} */ (getLexicalFunctionName(node)),
      );
      funStack.push({name, node});
      if (
        matchers.isDollarFunction(name) ||
        matchers.isIgnoredFunction(name) ||
        matchers.isLexicalProvider(name)
      ) {
        pushIgnoredNode(node);
      }
    };
    const popFunction = (/** @type {Node} */ node) => {
      funStack.pop();
      popIgnoredNode(node);
    };
    const getParentLexicalFunctionNameIdentifier = (
      /** @type {Node} */ _node,
    ) => {
      const pair = funStack[funStack.length - 1];
      return pair ? pair.name : undefined;
    };
    // Find all $function calls that are not inside a class or inside a $function
    // by visiting all function definitions and calls
    return {
      ArrowFunctionExpression: pushFunction,
      'ArrowFunctionExpression:exit': popFunction,
      CallExpression: node => {
        if (shouldIgnore()) {
          return;
        }
        const calleeName = getFunctionNameIdentifier(
          /** @type {Node} */ (node.callee),
        );
        if (
          matchers.isLexicalProvider(calleeName) ||
          matchers.isSafeDollarFunction(calleeName)
        ) {
          pushIgnoredNode(node);
          return;
        }
        if (!matchers.isDollarFunction(calleeName)) {
          return;
        }
        const nameIdentifier = getParentLexicalFunctionNameIdentifier(node);
        if (!nameIdentifier || reportedSet.has(nameIdentifier)) {
          return;
        }
        reportedSet.add(nameIdentifier);
        const variable = getIdentifierVariable(sourceCode, nameIdentifier);
        const suggestName = getSuggestName(nameIdentifier, variable);
        const exportDeclaration = getExportDeclaration(variable);
        const data = {
          callee: sourceCode.getText(node.callee),
          caller: sourceCode.getText(nameIdentifier),
          suggestName,
        };
        /** @type {ReportFixer} */
        const fix = fixer => {
          /** @type {Set<Identifier>} */
          const replaced = new Set();
          /** @type {Fix[]} */
          const fixes = [];
          const renameIdentifier = (/** @type {Identifier} */ identifier) => {
            if (!replaced.has(identifier)) {
              replaced.add(identifier);
              fixes.push(fixer.replaceText(identifier, suggestName));
            }
          };
          renameIdentifier(nameIdentifier);
          if (exportDeclaration) {
            fixes.push(
              fixer.insertTextAfter(exportDeclaration, renameExportText(data)),
            );
          }
          if (variable) {
            for (const ref of variable.references) {
              renameIdentifier(/** @type {Identifier} */ (ref.identifier));
            }
          }
          return fixes;
        };
        context.report({
          data,
          fix,
          messageId: 'rulesOfLexicalReport',
          node: nameIdentifier,
          suggest: [
            {
              data,
              fix,
              messageId: 'rulesOfLexicalSuggestion',
            },
          ],
        });
      },
      'CallExpression:exit': popIgnoredNode,
      ClassBody: pushIgnoredNode,
      'ClassBody:exit': popIgnoredNode,
      FunctionDeclaration: pushFunction,
      'FunctionDeclaration:exit': popFunction,
      FunctionExpression: pushFunction,
      'FunctionExpression:exit': popFunction,
    };
  },
  meta: {
    docs: {
      description: 'enforces the Rules of Lexical',
      recommended: true,
      url: 'https://lexical.dev/docs/packages/lexical-eslint-plugin',
    },
    fixable: 'code',
    hasSuggestions: true,
    messages: {
      rulesOfLexicalReport:
        '{{ callee }} called from {{ caller }}, without $ prefix or read/update context',
      rulesOfLexicalSuggestion: 'Rename {{ caller }} to {{ suggestName }}',
    },
    schema: [
      {
        additionalProperties: false,
        properties: {
          isDollarFunction: matcherSchema,
          isIgnoredFunction: matcherSchema,
          isLexicalProvider: matcherSchema,
          isSafeDollarFunction: matcherSchema,
        },
        type: 'object',
      },
    ],
    type: 'suggestion',
  },
};
