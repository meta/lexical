/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Imported from source (rather than by package name) so that linting works
// before the packages have been built, as scripts/build.mjs does. The rule
// asks the transform which names it would annotate rather than keeping a
// second list of its own: an annotation is only removed when the build is
// guaranteed to put it back.
import {
  PURE_FACTORY_FUNCTIONS,
  pureCallNames,
  rootObjectName,
} from '../../../lexical-compiler/src/passes/pureAnnotations.mjs';

/**
 * A `\/* @__PURE__ *\/` written in the source is redundant where the build
 * injects one: the transform is idempotent and would leave it alone, but
 * keeping them in the tree is what this project moved away from — they
 * invite cargo-culting into positions where an annotation does nothing
 * (inside a function body, on a call whose callee is not side-effect free at
 * all).
 *
 * This is the inverse of the `require-pure-annotation` rule it replaces, so
 * a branch written before the transform existed migrates with
 * `pnpm run lint:fix`.
 */
const PURE_ANNOTATION = /[#@]__PURE__/;

/**
 * True when the call is evaluated during module initialization, which is the
 * only place the build injects an annotation. An annotation inside a function
 * body, a class field, or a static block was written deliberately by somebody
 * and is left alone.
 *
 * @param {import('eslint').Rule.Node} node
 * @returns {boolean}
 */
function isModuleScopeEvaluation(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    switch (parent.type) {
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
      case 'PropertyDefinition':
      case 'StaticBlock':
        return false;
      default:
        break;
    }
  }
  return true;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  create(context) {
    const sourceCode = context.sourceCode;
    const [options] = context.options;
    const functions = (options && options.functions) || PURE_FACTORY_FUNCTIONS;
    /** @type {undefined | {functions: ReadonlySet<string>, namespaces: ReadonlySet<string>}} */
    let resolved;
    /**
     * The names the build would annotate in this module, resolved by the
     * transform itself: imported from a Lexical package, declared here as
     * side-effect free, or imported from a relative module that declares it
     * that way. A same-named local helper does not qualify, and removing its
     * annotation would shrink nothing and grow the bundle.
     *
     * @returns {ReadonlySet<string>}
     */
    function resolvedNames() {
      if (resolved === undefined) {
        try {
          resolved = pureCallNames(sourceCode.getText(), {
            filename: context.filename,
            functions,
          });
        } catch {
          // Syntax the transform's parser does not cover: say nothing rather
          // than remove an annotation on a guess.
          resolved = {functions: new Set(), namespaces: new Set()};
        }
      }
      return resolved;
    }

    /**
     * The build annotates the outermost call of a chain, and one annotation
     * there covers the whole chain, so only that call's annotation is
     * redundant — and reporting the inner ones would report the same comment
     * more than once.
     *
     * @param {import('eslint').Rule.Node} node
     * @returns {boolean}
     */
    function isOutermostCall(node) {
      const {parent} = node;
      return !(
        parent &&
        parent.type === 'MemberExpression' &&
        parent.object === node &&
        parent.parent &&
        parent.parent.type === 'CallExpression' &&
        parent.parent.callee === parent
      );
    }

    return {
      CallExpression(node) {
        const {callee} = node;
        if (
          callee.type !== 'Identifier' &&
          callee.type !== 'MemberExpression'
        ) {
          return;
        }
        if (!isModuleScopeEvaluation(node) || !isOutermostCall(node)) {
          return;
        }
        const comments = sourceCode.getCommentsBefore(node);
        const annotation = comments[comments.length - 1];
        if (
          !annotation ||
          annotation.type !== 'Block' ||
          !PURE_ANNOTATION.test(annotation.value)
        ) {
          return;
        }
        const {functions: factories, namespaces} = resolvedNames();
        const root =
          callee.type === 'Identifier' ? callee.name : rootObjectName(callee);
        if (
          root === null ||
          !(callee.type === 'Identifier'
            ? factories.has(root)
            : namespaces.has(root))
        ) {
          return;
        }
        context.report({
          data: {name: root},
          fix(fixer) {
            // Everything from the annotation up to the call is the comment
            // and the whitespace after it.
            return fixer.removeRange([annotation.range[0], node.range[0]]);
          },
          loc: annotation.loc,
          messageId: 'unnecessaryPureAnnotation',
        });
      },
    };
  },
  meta: {
    docs: {
      description:
        'disallow hand-written /* @__PURE__ */ annotations on module-scope' +
        ' calls to the side-effect-free lexical factories, which the build' +
        ' injects with @lexical/compiler',
      recommended: true,
    },
    fixable: 'code',
    messages: {
      unnecessaryPureAnnotation:
        'Remove this /* @__PURE__ */ annotation: the build injects it for' +
        ' every module-scope call to {{name}} (@lexical/compiler),' +
        ' for the published bundles and for anything built from source.',
    },
    schema: [
      {
        additionalProperties: false,
        properties: {
          functions: {
            items: {type: 'string'},
            type: 'array',
          },
        },
        type: 'object',
      },
    ],
    type: 'suggestion',
  },
};

export default rule;
