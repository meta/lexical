/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Options passed to a `@webext-pegasus/transport` initializer that name the
 * window messaging channel.
 */
const NAMESPACE_OPTIONS = new Set([
  'namespace',
  'allowWindowMessagingForNamespace',
]);

const TRANSPORT_INITIALIZER = 'initPegasusTransport';
const TRANSPORT_MODULE = '@webext-pegasus/transport';

/**
 * TypeScript-only wrappers that change an expression's type and nothing about
 * its value, so a constant inside one is still a constant.
 */
const TYPE_ONLY_WRAPPERS = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
  'TSNonNullExpression',
  'TSInstantiationExpression',
]);

/**
 * @param {any} node
 * @returns {any}
 */
function unwrapTypeOnly(node) {
  let current = node;
  while (current && TYPE_ONLY_WRAPPERS.has(current.type)) {
    current = current.expression;
  }
  return current;
}

/**
 * @param {string} source
 * @returns {boolean}
 */
function isTransportModule(source) {
  return (
    source === TRANSPORT_MODULE || source.startsWith(`${TRANSPORT_MODULE}/`)
  );
}

/**
 * Resolve an identifier to the variable it refers to, honoring shadowing.
 *
 * Prefers the reference recorded by the scope analyzer, so a parameter that
 * shadows a module binding resolves to the parameter.
 *
 * @param {any} node
 * @param {any} scope
 * @returns {any}
 */
function resolveVariable(node, scope) {
  for (let current = scope; current; current = current.upper) {
    const reference = current.references.find(
      (/** @type {any} */ ref) => ref.identifier === node,
    );
    if (reference) {
      return reference.resolved;
    }
  }
  for (let current = scope; current; current = current.upper) {
    const found = current.variables.find(
      (/** @type {any} */ v) => v.name === node.name,
    );
    if (found) {
      return found;
    }
  }
  return null;
}

/**
 * Does this variable come from an import of the transport package?
 *
 * With `importedName`, the specifier must import that name — an alias on this
 * side does not matter. Without it, only a namespace import matches.
 *
 * @param {any} variable
 * @param {string} [importedName]
 * @returns {boolean}
 */
function isTransportImport(variable, importedName) {
  if (!variable) {
    return false;
  }
  return variable.defs.some((/** @type {any} */ def) => {
    if (def.type !== 'ImportBinding') {
      return false;
    }
    const source = def.parent && def.parent.source;
    if (
      !source ||
      typeof source.value !== 'string' ||
      !isTransportModule(source.value)
    ) {
      return false;
    }
    if (def.node.type === 'ImportNamespaceSpecifier') {
      return importedName === undefined;
    }
    if (def.node.type === 'ImportSpecifier') {
      return (
        importedName !== undefined && def.node.imported.name === importedName
      );
    }
    return false;
  });
}

/**
 * How a value was found to be fixed, or `null` if it was not.
 *
 * `literal` — resolves to a constant string in this file.
 * `import` — an imported binding, whose value this rule cannot see.
 *
 * @typedef {'literal' | 'import' | null} Fixedness
 */

/**
 * Classify an expression as fixed for every page and installation, or not.
 *
 * Returns `null` for anything computed at runtime — a call, a member access,
 * a parameter, a reassigned binding — which is the shape this rule asks for.
 *
 * @param {any} node
 * @param {any} scope
 * @param {number} [depth]
 * @returns {Fixedness}
 */
function classifyFixedness(node, scope, depth = 0) {
  const expression = unwrapTypeOnly(node);
  if (!expression || depth > 5) {
    return null;
  }

  if (expression.type === 'Literal') {
    return typeof expression.value === 'string' ? 'literal' : null;
  }

  if (expression.type === 'TemplateLiteral') {
    return expression.expressions.every(
      (/** @type {any} */ part) =>
        classifyFixedness(part, scope, depth + 1) === 'literal',
    )
      ? 'literal'
      : null;
  }

  if (expression.type === 'BinaryExpression' && expression.operator === '+') {
    return classifyFixedness(expression.left, scope, depth + 1) === 'literal' &&
      classifyFixedness(expression.right, scope, depth + 1) === 'literal'
      ? 'literal'
      : null;
  }

  if (expression.type === 'Identifier') {
    const variable = resolveVariable(expression, scope);
    if (!variable || variable.defs.length !== 1) {
      return null;
    }
    const def = variable.defs[0];

    if (def.type === 'ImportBinding') {
      return 'import';
    }

    if (
      def.type === 'Variable' &&
      def.node.type === 'VariableDeclarator' &&
      def.parent &&
      def.parent.kind === 'const'
    ) {
      // Resolve the initializer in the scope where it was declared, not where
      // it is used, so a shadowing binding at the call site cannot change the
      // answer in either direction.
      return classifyFixedness(def.node.init, variable.scope, depth + 1);
    }
  }

  return null;
}

/**
 * The constant string an expression resolves to, where that is knowable.
 *
 * @param {any} node
 * @param {any} scope
 * @param {number} [depth]
 * @returns {string | null}
 */
function constantStringValue(node, scope, depth = 0) {
  const expression = unwrapTypeOnly(node);
  if (!expression || depth > 5) {
    return null;
  }
  if (expression.type === 'Literal') {
    return typeof expression.value === 'string' ? expression.value : null;
  }
  if (
    expression.type === 'TemplateLiteral' &&
    expression.expressions.length === 0
  ) {
    return expression.quasis[0].value.cooked;
  }
  if (expression.type === 'Identifier') {
    const variable = resolveVariable(expression, scope);
    if (!variable || variable.defs.length !== 1) {
      return null;
    }
    const def = variable.defs[0];
    if (
      def.type === 'Variable' &&
      def.node.type === 'VariableDeclarator' &&
      def.parent &&
      def.parent.kind === 'const'
    ) {
      return constantStringValue(def.node.init, variable.scope, depth + 1);
    }
  }
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  create(context) {
    const sourceCode = context.sourceCode;

    /**
     * @param {any} node
     * @returns {any}
     */
    const scopeOf = node => {
      try {
        return sourceCode.getScope(node);
      } catch {
        return null;
      }
    };

    /**
     * Report a `targetOrigin` that resolves to `'*'`.
     *
     * @param {any} node
     */
    function checkTargetOrigin(node) {
      const expression = unwrapTypeOnly(node);
      if (!expression) {
        return;
      }
      if (constantStringValue(expression, scopeOf(expression)) === '*') {
        context.report({messageId: 'wildcardTargetOrigin', node: expression});
      }
    }

    /**
     * Is this callee the transport initializer, imported from the package?
     *
     * @param {any} callee
     * @returns {boolean}
     */
    function isTransportInitializerCall(callee) {
      if (callee.type === 'Identifier') {
        return isTransportImport(
          resolveVariable(callee, scopeOf(callee)),
          TRANSPORT_INITIALIZER,
        );
      }
      if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property.type === 'Identifier' &&
        callee.property.name === TRANSPORT_INITIALIZER &&
        callee.object.type === 'Identifier'
      ) {
        return isTransportImport(
          resolveVariable(callee.object, scopeOf(callee.object)),
        );
      }
      return false;
    }

    return {
      CallExpression(node) {
        const callee = unwrapTypeOnly(node.callee);

        // win.postMessage(message, targetOrigin)
        const isPostMessage =
          (callee.type === 'MemberExpression' &&
            !callee.computed &&
            callee.property.type === 'Identifier' &&
            callee.property.name === 'postMessage') ||
          (callee.type === 'Identifier' && callee.name === 'postMessage');

        if (isPostMessage && node.arguments.length >= 2) {
          checkTargetOrigin(node.arguments[1]);
        }

        if (!isTransportInitializerCall(callee)) {
          return;
        }

        const options = unwrapTypeOnly(node.arguments[0]);
        if (!options || options.type !== 'ObjectExpression') {
          return;
        }

        for (const property of options.properties) {
          if (
            property.type !== 'Property' ||
            property.computed ||
            property.key.type !== 'Identifier' ||
            !NAMESPACE_OPTIONS.has(property.key.name)
          ) {
            continue;
          }

          const fixedness = classifyFixedness(
            property.value,
            scopeOf(property.value),
          );
          if (fixedness === null) {
            continue;
          }

          context.report({
            data: {option: property.key.name},
            messageId:
              fixedness === 'import'
                ? 'importedMessagingNamespace'
                : 'staticMessagingNamespace',
            node: property.value,
          });
        }
      },

      // {targetOrigin: '*'} in an options object
      'Property[computed=false]'(node) {
        if (
          node.key.type === 'Identifier' &&
          node.key.name === 'targetOrigin'
        ) {
          checkTargetOrigin(node.value);
        }
      },
    };
  },
  meta: {
    docs: {
      description:
        'require a window messaging channel to be named per page load',
      recommended: false,
    },
    messages: {
      importedMessagingNamespace:
        'This `{{option}}` is imported, so this rule cannot tell whether it is derived per page load. Derive it at the call site, or add an eslint-disable with a note if the imported value is itself per-load.',
      staticMessagingNamespace:
        'This `{{option}}` resolves to a fixed string, so every page and every installation shares one channel name. Derive it per page load and pass it to the other side explicitly. The point is to avoid collisions and crosstalk between extensions, and between stale and fresh injections; the name is not a secret, so whatever arrives over the channel still has to be validated.',
      wildcardTargetOrigin:
        "This `targetOrigin` resolves to '*', which delivers the message to whatever document is there. Pass the origin you mean. A sandboxed frame with an opaque origin genuinely needs '*' — add an eslint-disable with a note for that case.",
    },
    schema: [],
    type: 'problem',
  },
};

export default rule;
