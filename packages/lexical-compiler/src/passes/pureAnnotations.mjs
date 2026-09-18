/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * The tree-shaking pass: the implementation behind
 * `@lexical/compiler/PureAnnotations`, whose typed facade is
 * `src/PureAnnotations.ts`. A pass lives here as plain JavaScript for
 * bootstrapping reasons — `scripts/build.mjs` runs under plain node and
 * imports it from source to annotate the packages it is building, before
 * anything has been compiled, and node cannot load TypeScript. Its types
 * are JSDoc, and `tsconfig.scripts.json` type-checks this directory with
 * `checkJs` and `strict`.
 *
 * The comments here spell the annotations without their leading sigil
 * (`__PURE__`, `__NO_SIDE_EFFECTS__`) because bundlers scan comments for
 * annotations, and one that does not precede a call expression is reported
 * as misplaced (rollup's INVALID_ANNOTATION). Only the string and regexp
 * literals below contain the real tokens.
 */

import {parse} from '@babel/parser';
import MagicString from 'magic-string';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The Lexical factories that are annotated with `__NO_SIDE_EFFECTS__` at
 * their definition. That annotation is only honored by esbuild for calls in
 * the same file as the definition (and not at all by webpack/terser), so
 * every module-scope call site needs its own `__PURE__` annotation for
 * bundlers to tree-shake unused extension/command/rule definitions out of
 * application bundles.
 *
 * Argument-position calls (e.g. `configExtension` / `safeCast` inside a
 * `defineExtension` config) matter too: a pure call is only removable when
 * its arguments are also side-effect-free, so one unannotated nested call
 * pins the entire enclosing definition.
 *
 * @type {ReadonlyArray<string>}
 */
export const PURE_FACTORY_FUNCTIONS = [
  'configExtension',
  'createCommand',
  'createContextState',
  'createImportState',
  'createRenderState',
  'createState',
  'declarePeerDependency',
  'defineExtension',
  'defineImportRule',
  'defineOverlayRules',
  'domOverride',
  'safeCast',
];

/**
 * The factories whose implementation is a trivial expression over their own
 * arguments, and the shape a call to them can be replaced with. Eliding the
 * call is better than annotating it: a literal is inert for every bundler,
 * with no annotation to preserve and nothing left to pin the definition it
 * appears in.
 *
 * Each of these is marked `@lexical-inline <form>` where it is defined, and
 * the unit tests check both that the marker and this table agree and that
 * the real function still returns what the form claims. `createCommand` is
 * deliberately not here: `{type: x}` is more bytes than a call to a minified
 * one-character name.
 *
 * - `identity` returns its single argument
 * - `args` returns all of its arguments as an array
 *
 * @type {ReadonlyMap<string, {form: 'args' | 'identity'}>}
 */
const INLINE_FACTORIES = new Map([
  ['configExtension', {form: 'args'}],
  ['declarePeerDependency', {form: 'args'}],
  ['defineExtension', {form: 'identity'}],
  ['defineImportRule', {form: 'identity'}],
  ['safeCast', {form: 'identity'}],
]);

/** The marker a definition uses to declare itself inlinable. */
// A JSDoc tag, so it has to start its line (after the comment's own `*`).
// Prose that merely mentions the tag — including this file's own
// documentation of it — is not a marker.
const INLINE_MARKER_RE =
  /^[^\S\n]*\*?[^\S\n]*@lexical-inline(?:[^\S\n]+(\S+))?[^\S\n]*$/m;

/**
 * An error the author has to act on — a malformed marker, or a call this
 * transform cannot prove is safe — as opposed to source it cannot parse.
 * The plugin passes an unparseable module through with a warning; these it
 * rethrows, because ignoring them would silently produce the bundle the
 * author was trying to avoid.
 */
export class PureAnnotationsError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'PureAnnotationsError';
  }
}

// The tag that declares an object's methods side-effect free, so that a
// namespace reached through a relative import or a local alias — as
// @lexical/html's own modules reach `selBase` — is recognized without
// having to be listed in the table above.
const NAMESPACE_MARKER_RE =
  /^[^\S\n]*\*?[^\S\n]*@lexical-pure-namespace[^\S\n]*$/m;

/** The forms a `@lexical-inline` marker may name. */
const INLINE_FORMS = new Set(['args', 'identity']);

/**
 * Imported objects whose method calls are side-effect free, so that a
 * module-scope call like `sel.tag('p').attr('data-x', true)` is annotated
 * the same way a call to a factory function is. Only the outermost call of
 * a chain is annotated: rollup, terser and esbuild all drop the whole chain
 * from that one annotation.
 *
 * As with the factories, the name is only trusted when it is imported from
 * a Lexical package.
 */
export const PURE_NAMESPACES = ['sel'];

/**
 * The form each inlinable factory is replaced with, for the tests that keep
 * this table honest and for anyone who wants to know what `inline` does.
 *
 * @type {ReadonlyMap<string, string>}
 */
export const INLINE_FACTORY_FORMS = new Map(
  Array.from(INLINE_FACTORIES, ([name, spec]) => [name, spec.form]),
);

/**
 * The annotation inserted before a module-scope factory call. No trailing
 * space: a block comment is a token separator on its own, so the space would
 * only be there to be stripped again by the minifier.
 */
const ANNOTATION = '/* @__PURE__ */';

/** Matches the contents of a comment that is already a pure annotation. */
/**
 * `overwrite` clears the intro and outro of every chunk it spans unless it is
 * told to touch the content only — and an annotation this transform appended
 * to a nested call lives in the outro of the chunk that ends where that call
 * begins. Replacing a call's `factory(` with `([` would take the annotation
 * on its first argument with it.
 *
 * @type {{contentOnly: true}}
 */
const CONTENT_ONLY = {contentOnly: true};

const PURE_ANNOTATION_RE = /[#@]__PURE__/;

/** The file extensions the bundler plugin transforms by default. */
const DEFAULT_INCLUDE = /\.(?:[cm]?[jt]sx?)$/;

/**
 * Module specifiers whose exports are trusted to be the Lexical factories.
 * Every factory in PURE_FACTORY_FUNCTIONS is declared side-effect free in
 * these packages, so an import from one of them is evidence enough. A call
 * to a same-named function from anywhere else is only annotated when the
 * declaration it resolves to is itself marked side-effect free.
 */
const DEFAULT_SOURCES = [/^lexical$/, /^@lexical\//];

/** Matches the annotation a definition uses to declare itself pure. */
const NO_SIDE_EFFECTS_RE = /[#@]__NO_SIDE_EFFECTS__/;

/** An import of a module next to this one, which may declare a namespace. */
const RELATIVE_IMPORT_RE = /\bfrom\s*['"]\./;

/**
 * Expression types that read the same with or without the parentheses the
 * call they replace was written with: they are a single delimited token, so
 * no surrounding operator can bind into them. Anything else keeps the
 * parentheses, which costs two characters a minifier removes anyway.
 */
const SELF_DELIMITING_TYPES = new Set([
  'ArrayExpression',
  'BigIntLiteral',
  'BooleanLiteral',
  'DecimalLiteral',
  'Identifier',
  'JSXElement',
  'JSXFragment',
  'NullLiteral',
  'NumericLiteral',
  'ObjectExpression',
  'RegExpLiteral',
  'StringLiteral',
  'TemplateLiteral',
  'ThisExpression',
]);

/** Extensions tried when resolving an extensionless relative import. */
const RESOLVE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
];

/**
 * Node types whose contents are not evaluated when the module is
 * initialized. A `__PURE__` annotation only affects tree-shaking of
 * module-scope evaluation, so the walk never descends into these.
 */
/**
 * Built-ins whose construction or call has no side effects. Bundlers know
 * this for themselves (rollup's known globals, esbuild's primitive
 * handling), so requiring an annotation on `new Map([...])` inside a
 * definition would be noise.
 */
const PURE_GLOBALS = new Set([
  'Array',
  'BigInt',
  'Boolean',
  'Map',
  'Number',
  'Object',
  'RegExp',
  'Set',
  'String',
  'Symbol',
  'WeakMap',
  'WeakSet',
]);

/**
 * A dependency's own code. It is still annotated — a Lexical consumed
 * through its `source` export condition is resolved from here — but `strict`
 * does not apply to it: a definition somebody else shipped is not the
 * building project's to fix, and neither is a marker they got wrong.
 */
const NODE_MODULES_RE = /[\\/]node_modules[\\/]/;

const DEFERRED_TYPES = new Set([
  'ArrowFunctionExpression',
  'ClassAccessorProperty',
  'ClassMethod',
  'ClassPrivateMethod',
  'ClassPrivateProperty',
  'ClassProperty',
  'FunctionDeclaration',
  'FunctionExpression',
  'ObjectMethod',
  'PropertyDefinition',
  'StaticBlock',
  'TSDeclareMethod',
]);

/** AST properties that never contain child nodes worth visiting. */
/** @type {ReadonlySet<string>} */
const EMPTY_NAMES = new Set();

const SKIPPED_KEYS = new Set([
  'comments',
  'extra',
  'innerComments',
  'leadingComments',
  'loc',
  'trailingComments',
]);

/**
 * @param {undefined | string} filename
 * @param {undefined | ReadonlyArray<any>} extraPlugins
 * @returns {Array<any>} the Babel parser plugins to parse this file with
 */
function parserPluginsFor(filename, extraPlugins) {
  const name = typeof filename === 'string' ? filename : '';
  const isTypeScript = /\.[cm]?tsx?$/i.test(name);
  /** @type {Array<any>} */
  const plugins = ['explicitResourceManagement'];
  if (isTypeScript) {
    plugins.push('typescript');
  }
  // `<T>(value: T) => value` in a .ts file is a generic arrow function, not
  // an opening JSX element, so the jsx plugin must stay off there. Any other
  // extension (including an unknown one) is parsed with jsx enabled.
  if (!isTypeScript || /\.[cm]?tsx$/i.test(name)) {
    plugins.push('jsx');
  }
  return extraPlugins ? plugins.concat(extraPlugins) : plugins;
}

/**
 * Find the block comment that ends immediately before `offset` (ignoring
 * whitespace), if any.
 *
 * This reads the source text rather than the parsed `leadingComments` so
 * that a comment attached to an enclosing statement (one that precedes
 * `export const x = f()` rather than the call itself, where it does nothing)
 * is not mistaken for an annotation on the call.
 *
 * @param {string} code
 * @param {number} offset
 * @returns {null | {end: number, start: number, value: string}}
 */
function blockCommentBefore(code, offset) {
  let end = offset;
  while (end > 0 && /\s/.test(code[end - 1])) {
    end--;
  }
  if (end < 4 || code[end - 1] !== '/' || code[end - 2] !== '*') {
    return null;
  }
  const start = code.lastIndexOf('/*', end - 2);
  if (start === -1) {
    return null;
  }
  return {end, start, value: code.slice(start + 2, end - 2)};
}

/**
 * @param {string} code
 * @param {number} offset the start of a call expression
 * @returns {boolean} true when the call already carries a pure annotation
 */
function hasPureAnnotation(code, offset) {
  const comment = blockCommentBefore(code, offset);
  return comment !== null && PURE_ANNOTATION_RE.test(comment.value);
}

/**
 * The identifier a member-expression callee is rooted at, so that every call
 * in `sel.tag('p').attr('x')` resolves to `sel`.
 *
 * @param {any} callee
 * @returns {null | string} the name, or null when the callee is not rooted
 *   at a plain identifier
 */
export function rootObjectName(callee) {
  for (let node = callee; node; ) {
    if (node.type === 'Identifier') {
      return node.name;
    } else if (node.type === 'MemberExpression') {
      node = node.object;
    } else if (node.type === 'CallExpression') {
      node = node.callee;
    } else {
      return null;
    }
  }
  return null;
}

/**
 * The names a nested block binds for itself with `let`, `const`, `class` or
 * a function declaration. Only these shadow an outer binding: `var` is
 * scoped to the module, so a `var` of an imported name is a redeclaration
 * error rather than a shadow.
 *
 * @param {any} node
 * @returns {null | Set<string>} the names, or null when this node binds none
 */
function blockScopedNames(node) {
  // Only a nested block: the module's own declarations are the bindings the
  // transform resolved in the first place, not shadows of them.
  const body =
    node.type === 'BlockStatement'
      ? node.body
      : node.type === 'SwitchCase'
        ? node.consequent
        : null;
  if (body === null) {
    return null;
  }
  /** @type {null | Set<string>} */
  let names = null;
  /** @param {string} name */
  const add = name => {
    names = names || new Set();
    names.add(name);
  };
  for (const statement of body) {
    if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') {
      for (const declarator of statement.declarations) {
        if (declarator.id.type === 'Identifier') {
          add(declarator.id.name);
        }
      }
    } else if (
      (statement.type === 'FunctionDeclaration' ||
        statement.type === 'ClassDeclaration') &&
      statement.id
    ) {
      add(statement.id.name);
    }
  }
  return names;
}

/**
 * Walk every node that is evaluated when the module is initialized, calling
 * `visitor` with each module-scope call to one of the factories, or to a
 * method of one of the namespaces, and where it sits: `discarded` when the
 * call's value is thrown away (it is the whole of an expression statement),
 * and `statementStart` when it begins one, both of which constrain what it
 * can be replaced with. `namespace` marks a method call, which is annotated
 * but never replaced.
 *
 * @param {any} node
 * @param {{functions: ReadonlyMap<string, any> | ReadonlySet<string>, namespaces?: ReadonlySet<string>}} names
 * @param {(node: any, position: {discarded: boolean, namespace?: boolean, statementStart: boolean}) => void} visitor
 * @param {{discarded: boolean, shadowed: ReadonlySet<string>, statementStarts: Set<number>}} [state]
 */
function visitModuleScopeCalls(node, names, visitor, state) {
  const {functions, namespaces} = names;
  const walkState = state || {
    discarded: false,
    shadowed: EMPTY_NAMES,
    statementStarts: new Set(),
  };
  if (Array.isArray(node)) {
    for (const child of node) {
      visitModuleScopeCalls(child, names, visitor, {
        discarded: false,
        shadowed: walkState.shadowed,
        statementStarts: walkState.statementStarts,
      });
    }
    return;
  }
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') {
    return;
  }
  if (DEFERRED_TYPES.has(node.type)) {
    return;
  }
  if (node.type === 'ExpressionStatement') {
    // Every node that begins an expression statement starts at the same
    // offset, so recording that one offset identifies the whole leftmost
    // chain — the positions where an object literal would be read as a
    // block, whatever it is nested in.
    walkState.statementStarts.add(node.expression.start);
  }
  // Only a plain CallExpression: `factory?.(x)` parses as an
  // OptionalCallExpression, and it evaluates to undefined when the factory
  // is missing rather than to what the factory returns.
  if (node.type === 'CallExpression' && node.callee) {
    const position = {
      discarded: walkState.discarded,
      statementStart: walkState.statementStarts.has(node.start),
    };
    if (
      node.callee.type === 'Identifier' &&
      functions.has(node.callee.name) &&
      !walkState.shadowed.has(node.callee.name)
    ) {
      visitor(node, position);
    } else if (namespaces !== undefined && namespaces.size > 0) {
      const root = rootObjectName(node.callee);
      if (
        root !== null &&
        namespaces.has(root) &&
        !walkState.shadowed.has(root)
      ) {
        visitor(node, {...position, namespace: true});
      }
    }
  }
  // A block that rebinds one of the names is talking about something else
  // inside itself, and that something else may well have side effects.
  const bound = blockScopedNames(node);
  const shadowed =
    bound === null
      ? walkState.shadowed
      : new Set([...walkState.shadowed, ...bound]);
  for (const key of Object.keys(node)) {
    if (!SKIPPED_KEYS.has(key)) {
      const value = node[key];
      if (value && typeof value === 'object') {
        visitModuleScopeCalls(value, names, visitor, {
          discarded:
            node.type === 'ExpressionStatement' && key === 'expression',
          shadowed,
          statementStarts: walkState.statementStarts,
        });
      }
    }
  }
}

/**
 * True when a call to a factory of this form can be replaced by the literal
 * it would have returned. Anything the form cannot account for — a spread
 * argument, the wrong number of arguments, a comma expression that would
 * lose its parentheses — is annotated instead.
 *
 * @param {any} node the call expression
 * @param {{form: string}} spec
 * @returns {boolean}
 */
function canInlineCall(node, spec) {
  const args = node.arguments;
  if (spec.form === 'identity') {
    return (
      args.length === 1 &&
      args[0].type !== 'SpreadElement' &&
      args[0].type !== 'SequenceExpression'
    );
  }
  return true;
}

/**
 * Walk every node in the tree, calling `visit` with each node and the node
 * and key that hold it. Unlike visitModuleScopeCalls this does not stop at
 * function boundaries: it is used to prove that a name is *not* referenced
 * anywhere else in the module.
 *
 * @param {any} node
 * @param {(node: any, parent: any, key: string) => void} visit
 * @param {any} [parent]
 * @param {string} [key]
 */
function walkAllNodes(node, visit, parent, key) {
  if (Array.isArray(node)) {
    for (const child of node) {
      walkAllNodes(child, visit, parent, key);
    }
    return;
  }
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') {
    return;
  }
  visit(node, parent, /** @type {string} */ (key));
  for (const childKey of Object.keys(node)) {
    if (!SKIPPED_KEYS.has(childKey)) {
      const value = node[childKey];
      if (value && typeof value === 'object') {
        walkAllNodes(value, visit, node, childKey);
      }
    }
  }
}

/**
 * True when an identifier node is a reference to a binding rather than a
 * name in some other position (a property name, an import specifier, ...).
 * Anything unrecognized counts as a reference, so an unexpected position
 * keeps the import rather than removing one that is still needed.
 *
 * @param {any} node
 * @param {any} parent
 * @param {string} key
 * @returns {boolean}
 */
function isValueReference(node, parent, key) {
  if (node.type !== 'Identifier' && node.type !== 'JSXIdentifier') {
    return false;
  }
  if (!parent) {
    return true;
  }
  switch (parent.type) {
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
    case 'ImportSpecifier':
      return false;
    case 'ExportSpecifier':
      // `export {imported as somethingElse}` still refers to the binding.
      return key === 'local';
    case 'OptionalMemberExpression':
    case 'MemberExpression':
      return key !== 'property' || parent.computed === true;
    case 'ClassMethod':
    case 'ClassProperty':
    case 'ObjectMethod':
    case 'ObjectProperty':
      return key !== 'key' || parent.computed === true;
    default:
      return true;
  }
}

/**
 * Remove the import specifiers whose only uses were calls that have just
 * been replaced by a literal, so the transform does not leave behind an
 * import that nothing references (which bundlers then warn about).
 *
 * @param {MagicString} magicString
 * @param {string} code
 * @param {any} program
 * @param {ReadonlyArray<any>} inlinedCalls the call nodes that were replaced
 */
function removeUnusedImports(magicString, code, program, inlinedCalls) {
  const callees = new Set(inlinedCalls.map(node => node.callee));
  const names = new Set(inlinedCalls.map(node => node.callee.name));
  if (names.size === 0) {
    return;
  }
  // A name is still needed if anything other than an inlined callee refers
  // to it, anywhere in the module.
  walkAllNodes(program, (node, parent, key) => {
    if (
      names.has(node.name) &&
      !callees.has(node) &&
      isValueReference(node, parent, key)
    ) {
      names.delete(node.name);
    }
  });
  for (const statement of program.body) {
    if (
      statement.type !== 'ImportDeclaration' ||
      statement.importKind === 'type'
    ) {
      continue;
    }
    const {specifiers} = statement;
    const named = specifiers.filter(
      /** @param {any} specifier */ specifier =>
        specifier.type === 'ImportSpecifier',
    );
    const removable = named.filter(
      /** @param {any} specifier */ specifier =>
        specifier.importKind !== 'type' && names.has(specifier.local.name),
    );
    if (removable.length === 0) {
      continue;
    }
    if (removable.length < named.length) {
      // Some names are still used: take out each unused one along with the
      // comma that separates it from the named import next to it. Adjacent
      // unused ones go as a single range — two overlapping removals would
      // leave the comma of the first behind (`import {a, } from 'x'`).
      const removableSet = new Set(removable);
      for (let start = 0; start < named.length; start++) {
        if (!removableSet.has(named[start])) {
          continue;
        }
        let end = start;
        while (end + 1 < named.length && removableSet.has(named[end + 1])) {
          end++;
        }
        if (end + 1 < named.length) {
          magicString.remove(named[start].start, named[end + 1].start);
        } else {
          magicString.remove(named[start - 1].end, named[end].end);
        }
        start = end;
      }
      continue;
    }
    const close = code.indexOf('}', named[named.length - 1].end);
    if (named.length < specifiers.length) {
      // A default or namespace import is still there, so only the braced
      // clause and the comma before it go.
      const previous = specifiers[specifiers.indexOf(named[0]) - 1];
      magicString.remove(code.indexOf(',', previous.end), close + 1);
      continue;
    }
    // Nothing is imported from the module any more. Dropping the import
    // drops the module, which is only safe because it has no side effects to
    // run: the factories come either from a Lexical package (all of which
    // are `sideEffects: false`) or from a module that declares functions
    // side-effect free and inlinable. A module that exports such a factory
    // and also does something at import time is out of scope by
    // construction — Lexical has no modules with top-level side effects, and
    // neither should a module that a build is told to inline from.
    magicString.remove(statement.start, statement.end);
  }
}

/**
 * The offset just past a call's opening parenthesis, which is where its
 * argument list begins — including any parentheses the first argument was
 * written with, and any type arguments before it (`safeCast<T>(x)`).
 *
 * @param {string} code
 * @param {any} node a call expression
 * @returns {number}
 */
function argumentsStart(code, node) {
  const typeArguments = node.typeArguments || node.typeParameters;
  const from = Math.max(
    node.callee.end,
    typeArguments ? typeArguments.end : node.callee.end,
  );
  return code.indexOf('(', from) + 1;
}

/**
 * Replace a call with the literal the factory would have returned, keeping
 * the argument source text (and any nested edits within it) intact.
 *
 * @param {MagicString} magicString
 * @param {string} code
 * @param {any} node the call expression
 * @param {{form: string}} spec
 * @param {boolean} [statementStart] whether the call begins an expression
 *   statement, where an object literal would be read as a block
 */
function inlineCall(magicString, code, node, spec, statementStart) {
  const comment = blockCommentBefore(code, node.start);
  if (comment !== null && PURE_ANNOTATION_RE.test(comment.value)) {
    // Left in front of a literal the annotation does nothing, and bundlers
    // report it as misplaced.
    magicString.remove(comment.start, node.start);
  }
  const args = node.arguments;
  if (spec.form !== 'identity') {
    // The argument list becomes the array literal, so the edit is on the
    // call's own parentheses — `factory(` and its `)` — rather than on where
    // the first and last arguments start and end. Those exclude parentheses
    // an argument was written with (`configExtension(Ext, (cfg))`), which
    // would be left behind unbalanced.
    //
    // Parenthesized so that the replacement binds exactly like the call it
    // replaces, wherever that call was: a bare `[` at the start of an
    // expression statement is a member access on whatever the previous line
    // ended with, which is how ASI reads `f()\n[a, b].length`. Minifiers
    // drop the parentheses again.
    magicString.overwrite(
      node.start,
      argumentsStart(code, node),
      '([',
      CONTENT_ONLY,
    );
    magicString.overwrite(node.end - 1, node.end, '])', CONTENT_ONLY);
    return;
  }
  // The call's own parentheses were doing two jobs: grouping the argument
  // (`safeCast(a || b).c` must not become `a || b.c`) and, at the start of an
  // expression statement, keeping an object literal from being read as a
  // block. Keep them unless the argument reads the same without them.
  const keepParens =
    statementStart === true || !SELF_DELIMITING_TYPES.has(args[0].type);
  if (keepParens) {
    magicString.overwrite(node.start, args[0].start, '(', CONTENT_ONLY);
    magicString.overwrite(args[0].end, node.end, ')', CONTENT_ONLY);
  } else {
    magicString.remove(node.start, args[0].start);
    magicString.remove(args[0].end, node.end);
  }
}

/**
 * Caches for the files read while resolving relative imports. They live for
 * the lifetime of the process, which is what a build wants; a watch-mode
 * process that changes whether a declaration is marked side-effect free has
 * to be restarted for that to take effect (the annotations do not change
 * behavior, only what a bundler is allowed to drop).
 */
const resolvedFileCache = new Map();
const declarationCache = new Map();

/**
 * The form named by a declaration's `@lexical-inline` marker, if it has one.
 *
 * A marker naming a form this transform does not implement is an error
 * rather than a marker that silently does nothing: the whole point of the
 * marker is to say what a call may be replaced with, and a typo would leave
 * the factory quietly un-inlined.
 *
 * @param {undefined | ReadonlyArray<any>} comments
 * @param {undefined | string} filename the module the comments came from
 * @returns {null | string}
 */
function inlineMarkerForm(comments, filename) {
  if (comments) {
    for (const comment of comments) {
      const match = INLINE_MARKER_RE.exec(comment.value);
      if (match) {
        const form = match[1] || '';
        if (!INLINE_FORMS.has(form)) {
          const where = filename ? ` in ${filename}` : '';
          throw new PureAnnotationsError(
            `@lexical/compiler: unknown @lexical-inline form ` +
              `${form ? `"${form}"` : '(none given)'}${where}. Write ` +
              `\`@lexical-inline <form>\` with one of: ` +
              `${Array.from(INLINE_FORMS).sort().join(', ')}.`,
          );
        }
        return form;
      }
    }
  }
  return null;
}

/**
 * @param {undefined | ReadonlyArray<any>} comments
 * @returns {boolean} true when one of the comments is a NO_SIDE_EFFECTS annotation
 */
function hasNoSideEffectsComment(comments) {
  return (
    comments !== undefined &&
    comments !== null &&
    comments.some(comment => NO_SIDE_EFFECTS_RE.test(comment.value))
  );
}

/**
 * The names this module declares (at module scope) with a NO_SIDE_EFFECTS
 * annotation. Calls to these are safe to annotate wherever they appear,
 * because the definition itself says so. The value is the form from the
 * declaration's `@lexical-inline` marker, when it has one: purity alone is
 * evidence enough to annotate a call, but replacing one requires knowing the
 * shape of what the function returns.
 *
 * @param {any} program
 * @param {undefined | string} filename the module being read, for errors
 * @returns {Map<string, null | string>} declared name to its inline form
 */
function pureDeclaredNames(program, filename) {
  /** @type {Map<string, null | string>} */
  const names = new Map();
  for (const statement of program.body) {
    const declaration =
      statement.type === 'ExportNamedDeclaration' && statement.declaration
        ? statement.declaration
        : statement;
    const comments = (statement.leadingComments || []).concat(
      declaration === statement ? [] : declaration.leadingComments || [],
    );
    const declared = hasNoSideEffectsComment(comments);
    const inlineForm = inlineMarkerForm(comments, filename);
    if (
      // An overloaded function carries its documentation — and so its
      // annotation — on the first signature, which is a TSDeclareFunction;
      // the implementation that follows is a bare FunctionDeclaration.
      (declaration.type === 'FunctionDeclaration' ||
        declaration.type === 'TSDeclareFunction') &&
      declaration.id
    ) {
      if (declared) {
        names.set(declaration.id.name, inlineForm);
      }
    } else if (declaration.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations) {
        const declaratorComments = (declarator.leadingComments || []).concat(
          (declarator.init && declarator.init.leadingComments) || [],
        );
        if (
          declarator.id.type === 'Identifier' &&
          (declared || hasNoSideEffectsComment(declaratorComments))
        ) {
          names.set(
            declarator.id.name,
            inlineForm || inlineMarkerForm(declaratorComments, filename),
          );
        }
      }
    }
  }
  return names;
}

/**
 * Resolve a relative import specifier to a file on disk, trying the
 * extensions a bundler would (including the `.js` specifier TypeScript uses
 * for a `.ts` file).
 *
 * @param {string} filename the importing module
 * @param {string} specifier a relative specifier
 * @returns {null | string} the resolved path, or null when there is no such file
 */
function resolveRelativeSpecifier(filename, specifier) {
  const base = path.resolve(path.dirname(filename), specifier);
  const cached = resolvedFileCache.get(base);
  if (cached !== undefined) {
    return cached;
  }
  /** @type {Array<string>} */
  const candidates = [];
  const extension = path.extname(base);
  if (extension !== '') {
    candidates.push(base);
    if (/^\.[cm]?js$/.test(extension)) {
      const withoutExtension = base.slice(0, -extension.length);
      candidates.push(
        withoutExtension + extension.replace('js', 'ts'),
        withoutExtension + '.tsx',
      );
    }
  }
  for (const candidate of RESOLVE_EXTENSIONS) {
    candidates.push(base + candidate);
  }
  for (const candidate of RESOLVE_EXTENSIONS) {
    candidates.push(path.join(base, `index${candidate}`));
  }
  let resolved = null;
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        resolved = candidate;
        break;
      }
    } catch (_err) {
      // Not this candidate; try the next one.
    }
  }
  resolvedFileCache.set(base, resolved);
  return resolved;
}

/**
 * The side-effect-free declarations of another file, parsed and cached.
 *
 * @param {string} filename
 * @param {undefined | ReadonlyArray<any>} parserPlugins
 * @returns {ReadonlyMap<string, null | string>}
 */
function pureDeclaredNamesOfFile(filename, parserPlugins) {
  return declarationsOfFile(filename, parserPlugins).functions;
}

/**
 * What a module next to this one declares: the functions it says are
 * side-effect free, and the objects it marks as pure namespaces. Parsed
 * once per file for the life of the process — see the cache note above.
 *
 * @param {string} filename
 * @param {undefined | ReadonlyArray<any>} parserPlugins
 * @returns {{functions: ReadonlyMap<string, null | string>, namespaces: ReadonlySet<string>}}
 */
function declarationsOfFile(filename, parserPlugins) {
  const cached = declarationCache.get(filename);
  if (cached !== undefined) {
    return cached;
  }
  /** @type {null | any} */
  let program = null;
  try {
    program = parse(fs.readFileSync(filename, 'utf8'), {
      plugins: parserPluginsFor(filename, parserPlugins),
      sourceType: 'module',
    }).program;
  } catch (_err) {
    // A file this cannot read or parse simply provides no evidence. A
    // malformed marker inside a file it *can* read is a different matter:
    // reading the declarations happens outside this catch so that its error
    // reaches the build.
  }
  const declarations =
    program === null
      ? {functions: new Map(), namespaces: new Set()}
      : {
          functions: pureDeclaredNames(program, filename),
          namespaces: namespaceDeclaredNames(program),
        };
  declarationCache.set(filename, declarations);
  return declarations;
}

/**
 * The local names in this module that refer to a side-effect-free factory,
 * and may therefore have their module-scope calls annotated.
 *
 * A name qualifies when it is imported from a trusted Lexical package, when
 * it is declared in this module with a NO_SIDE_EFFECTS annotation, or when
 * it is imported from a relative module that declares it that way. A local
 * helper that merely shares a name with one of the factories does not
 * qualify, which is what keeps the transform from claiming that somebody
 * else's `safeCast` or `createState` has no side effects.
 *
 * @param {any} program
 * @param {ReadonlySet<string>} functions
 * @param {TransformPureAnnotationsOptions} opts
 * @returns {Map<string, {inline: undefined | any, name: string}>} local name
 *   to the factory it refers to, and the form it may be inlined with
 */
function collectFactoryNames(program, functions, opts) {
  const sources = toRegExpArray(opts.sources, DEFAULT_SOURCES);
  /** @type {Map<string, {inline: undefined | any, name: string}>} */
  const names = new Map();
  /**
   * A call is only replaced by a literal when the shape of what the factory
   * returns is known. An import from a Lexical package is taken on trust
   * (this package ships with that Lexical); anything else has to say so
   * itself with a `@lexical-inline` marker whose form matches the table.
   *
   * @param {string} local
   * @param {string} name
   * @param {null | string | undefined} markerForm
   * @param {boolean} trusted
   */
  function add(local, name, markerForm, trusted) {
    const spec = INLINE_FACTORIES.get(name);
    const inline =
      spec !== undefined
        ? // One of Lexical's own: an import from a Lexical package is taken
          // on trust, anything else has to agree with the table.
          trusted || markerForm === spec.form
          ? spec
          : undefined
        : // A factory of your own: its marker is the only thing that says
          // what its calls may be replaced with, so it is the authority.
          markerForm
          ? {form: markerForm}
          : undefined;
    names.set(local, {inline, name});
  }
  for (const [name, markerForm] of pureDeclaredNames(program, opts.filename)) {
    // A declaration in this module carries its own evidence, so it does not
    // have to be one of the known factory names: marking your own factory
    // `__NO_SIDE_EFFECTS__` is enough for the build to annotate its calls.
    // (A relatively imported one still has to be listed in `functions`, so
    // that a build does not parse every module it imports looking for one.)
    add(name, name, markerForm, false);
  }
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') {
      continue;
    }
    const source = statement.source.value;
    const trusted = matchesAny(sources, source);
    const relative =
      !trusted &&
      opts.relativeImports !== false &&
      typeof opts.filename === 'string' &&
      source.startsWith('.');
    if (!trusted && !relative) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      if (
        specifier.type !== 'ImportSpecifier' ||
        specifier.imported.type !== 'Identifier'
      ) {
        continue;
      }
      if (trusted) {
        if (functions.has(specifier.imported.name)) {
          add(specifier.local.name, specifier.imported.name, null, true);
        }
        continue;
      }
      const resolved = resolveRelativeSpecifier(
        /** @type {string} */ (opts.filename),
        source,
      );
      const declared =
        resolved === null
          ? undefined
          : pureDeclaredNamesOfFile(resolved, opts.parserPlugins).get(
              specifier.imported.name,
            );
      if (declared !== undefined) {
        add(specifier.local.name, specifier.imported.name, declared, false);
      }
    }
  }
  return names;
}

/**
 * @param {string} code
 * @param {ReadonlySet<string>} functions
 * @param {ReadonlySet<string>} namespaces
 * @returns {boolean} true when the source mentions any of the names at all
 */
function mayNeedAnnotations(code, functions, namespaces) {
  if (
    code.includes('__NO_SIDE_EFFECTS__') ||
    code.includes('@lexical-pure-namespace') ||
    RELATIVE_IMPORT_RE.test(code)
  ) {
    // Modules that may annotate calls for reasons other than the names in
    // the list: a declaration of their own, or a relatively imported
    // namespace, which is only known by reading that module.
    return true;
  }
  for (const name of functions) {
    if (code.includes(name)) {
      return true;
    }
  }
  for (const name of namespaces) {
    if (code.includes(name)) {
      return true;
    }
  }
  return false;
}

/**
 * @typedef {Object} TransformPureAnnotationsOptions
 * @property {string} [filename] Path of the module being transformed, used
 *   to choose the TypeScript and JSX parser plugins.
 * @property {Iterable<string>} [functions] Names of the factories whose
 *   module-scope calls are annotated. Defaults to PURE_FACTORY_FUNCTIONS.
 * @property {boolean} [inline] Replace calls to the factories whose result
 *   is a trivial expression over their arguments with that expression,
 *   rather than annotating them. Off by default: it assumes the Lexical
 *   being built matches this package's version.
 * @property {ReadonlyArray<any>} [parserPlugins] Extra Babel parser
 *   plugins, for syntax the defaults do not cover.
 * @property {boolean} [relativeImports] Set to false to skip reading
 *   relatively imported modules to look for a NO_SIDE_EFFECTS declaration.
 * @property {Iterable<string>} [namespaces] Imported objects whose
 *   method calls are side-effect free, defaults to PURE_NAMESPACES.
 * @property {boolean} [sourceMap] Set to false to skip source map generation.
 * @property {RegExp | ReadonlyArray<RegExp>} [sources] Module specifiers
 *   whose exports are trusted to be the factories, defaults to `lexical` and
 *   `@lexical/*`.
 * @property {boolean} [strict] Throw when a call evaluated inside one of the
 *   definitions is not known to be side-effect free, since it pins the
 *   definition into every bundle that imports the module.
 */

/**
 * @typedef {Object} PureAnnotationsResult
 * @property {number} count Number of annotations that were inserted.
 * @property {string} code
 * @property {number} inlined Number of calls that were replaced by the
 *   literal they would have returned.
 * @property {any} [map]
 */

/**
 * The names this module declares with a `@lexical-pure-namespace` marker:
 * objects whose methods are side-effect free.
 *
 * @param {any} program
 * @returns {Set<string>}
 */
function namespaceDeclaredNames(program) {
  /** @type {Set<string>} */
  const names = new Set();
  /** @param {undefined | ReadonlyArray<any>} comments */
  const marked = comments =>
    (comments || []).some(comment => NAMESPACE_MARKER_RE.test(comment.value));
  for (const statement of program.body) {
    const declaration =
      statement.type === 'ExportNamedDeclaration' && statement.declaration
        ? statement.declaration
        : statement;
    const outer = marked(statement.leadingComments);
    if (declaration.type !== 'VariableDeclaration') {
      continue;
    }
    for (const declarator of declaration.declarations) {
      if (
        declarator.id.type === 'Identifier' &&
        (outer ||
          marked(declaration.leadingComments) ||
          marked(declarator.leadingComments) ||
          (declarator.init && marked(declarator.init.leadingComments)))
      ) {
        names.add(declarator.id.name);
      }
    }
  }
  return names;
}

/**
 * The `@lexical-pure-namespace` names a relatively imported module declares.
 *
 * @param {string} filename
 * @param {undefined | ReadonlyArray<any>} parserPlugins
 * @returns {ReadonlySet<string>}
 */
function namespaceNamesOfFile(filename, parserPlugins) {
  return declarationsOfFile(filename, parserPlugins).namespaces;
}

/**
 * The local names in this module bound to one of the side-effect-free
 * namespaces, imported from a trusted Lexical package. A relative import is
 * not enough here: unlike a factory function, whose declaration can say
 * `__NO_SIDE_EFFECTS__` for itself, an object's methods are only known to
 * be pure by the table above.
 *
 * @param {any} program
 * @param {ReadonlySet<string>} namespaces
 * @param {TransformPureAnnotationsOptions} opts
 * @returns {Set<string>} local names
 */
function collectNamespaceNames(program, namespaces, opts) {
  /** @type {Set<string>} */
  const names = new Set();
  const sources = toRegExpArray(opts.sources, DEFAULT_SOURCES);
  for (const name of namespaceDeclaredNames(program)) {
    names.add(name);
  }
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') {
      continue;
    }
    const source = statement.source.value;
    const trusted = matchesAny(sources, source);
    const relative =
      !trusted &&
      opts.relativeImports !== false &&
      typeof opts.filename === 'string' &&
      source.startsWith('.');
    if (!trusted && !relative) {
      continue;
    }
    /** @type {undefined | ReadonlySet<string>} */
    let declared;
    for (const specifier of statement.specifiers) {
      if (
        specifier.type !== 'ImportSpecifier' ||
        specifier.imported.type !== 'Identifier'
      ) {
        continue;
      }
      if (trusted) {
        if (namespaces.has(specifier.imported.name)) {
          names.add(specifier.local.name);
        }
        continue;
      }
      if (declared === undefined) {
        const resolved = resolveRelativeSpecifier(
          /** @type {string} */ (opts.filename),
          source,
        );
        declared =
          resolved === null
            ? new Set()
            : namespaceNamesOfFile(resolved, opts.parserPlugins);
      }
      if (declared.has(specifier.imported.name)) {
        names.add(specifier.local.name);
      }
    }
  }
  // `const sel = selBase;` — an alias is the same object. One pass is
  // enough for the aliases these modules actually write.
  for (const statement of program.body) {
    if (statement.type !== 'VariableDeclaration') {
      continue;
    }
    for (const declarator of statement.declarations) {
      if (
        declarator.id.type === 'Identifier' &&
        declarator.init &&
        declarator.init.type === 'Identifier' &&
        names.has(declarator.init.name)
      ) {
        names.add(declarator.id.name);
      }
    }
  }
  return names;
}

/**
 * Every call evaluated inside `node`'s arguments, in the order they appear.
 * Calls in a deferred position (a callback, a method body) are not: they do
 * not run when the module is initialized, so they pin nothing.
 *
 * @param {any} node a call expression
 * @param {(call: any) => void} visit
 */
function visitEvaluatedCalls(node, visit) {
  /** @param {any} value */
  const walk = value => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (
      !value ||
      typeof value !== 'object' ||
      typeof value.type !== 'string' ||
      DEFERRED_TYPES.has(value.type)
    ) {
      return;
    }
    if (
      value.type === 'CallExpression' ||
      value.type === 'NewExpression' ||
      value.type === 'TaggedTemplateExpression'
    ) {
      visit(value);
    }
    for (const key of Object.keys(value)) {
      if (!SKIPPED_KEYS.has(key)) {
        walk(value[key]);
      }
    }
  };
  node.arguments.forEach(walk);
}

/**
 * A call in the arguments of an extension, command, or rule definition is
 * evaluated when the module is initialized, and an unannotated one pins the
 * whole definition into every bundle that imports the module — the
 * definition is only droppable when everything it is built from is too.
 *
 * With `strict`, that is an error naming the call rather than a definition
 * that quietly stops tree-shaking.
 *
 * @param {string} code
 * @param {undefined | string} filename
 * @param {ReadonlyArray<any>} factoryCalls
 * @param {ReadonlySet<number>} covered offsets this transform annotates or
 *   replaces
 */
function assertArgumentsArePure(code, filename, factoryCalls, covered) {
  /** @type {Array<string>} */
  const violations = [];
  /** @type {Set<number>} */
  const reported = new Set();
  for (const call of factoryCalls) {
    visitEvaluatedCalls(call, inner => {
      const callee = inner.callee || inner.tag;
      if (
        covered.has(inner.start) ||
        hasPureAnnotation(code, inner.start) ||
        reported.has(inner.start) ||
        (callee.type === 'Identifier' && PURE_GLOBALS.has(callee.name))
      ) {
        return;
      }
      reported.add(inner.start);
      const text = code.slice(callee.start, callee.end).replace(/\s+/g, ' ');
      const where = inner.loc
        ? `${inner.loc.start.line}:${inner.loc.start.column + 1}`
        : '?';
      violations.push(
        `  ${where} ${text}(...) inside ${code.slice(
          call.callee.start,
          call.callee.end,
        )}(...)`,
      );
    });
  }
  if (violations.length > 0) {
    throw new PureAnnotationsError(
      `@lexical/compiler: ${violations.length} call(s) evaluated ` +
        `inside a definition in ${filename || '<unknown>'} are not known to ` +
        `be side-effect free, so the definition cannot be tree-shaken:\n` +
        `${violations.join('\n')}\n` +
        `Make the call lazy, or declare the function side-effect free ` +
        `(@__NO_SIDE_EFFECTS__ plus the transform's \`functions\`/` +
        `\`namespaces\` options) so that its calls are annotated too.`,
    );
  }
}

/**
 * The local names in `code` whose module-scope calls this transform would
 * annotate — the same decision {@link transformPureAnnotations} makes, for
 * tooling that needs to ask about a module without rewriting it (Lexical's
 * `no-pure-annotation` ESLint rule removes a hand-written annotation only
 * for a name this returns, so that the build is guaranteed to put it back).
 *
 * `functions` are called directly, `namespaces` are the objects whose method
 * calls (`sel.tag('p').attr('x')`) are annotated.
 *
 * @param {string} code
 * @param {TransformPureAnnotationsOptions} [options]
 * @returns {{functions: Set<string>, namespaces: Set<string>}}
 */
export function pureCallNames(code, options) {
  const opts = options || {};
  const functions = new Set(opts.functions || PURE_FACTORY_FUNCTIONS);
  const ast = parse(code, {
    errorRecovery: false,
    plugins: parserPluginsFor(opts.filename, opts.parserPlugins),
    sourceFilename: opts.filename,
    sourceType: 'module',
  });
  return {
    functions: new Set(
      collectFactoryNames(ast.program, functions, opts).keys(),
    ),
    namespaces: collectNamespaceNames(
      ast.program,
      new Set(opts.namespaces || PURE_NAMESPACES),
      opts,
    ),
  };
}

/**
 * Insert a `__PURE__` annotation before every module-scope call to one of the
 * side-effect-free Lexical factories that does not already have one.
 *
 * Returns `null` when the module needs no annotations, so a caller can pass
 * the original source through untouched.
 *
 * @param {string} code
 * @param {TransformPureAnnotationsOptions} [options]
 * @returns {null | PureAnnotationsResult}
 */
export function transformPureAnnotations(code, options) {
  const opts = options || {};
  const functions = new Set(opts.functions || PURE_FACTORY_FUNCTIONS);
  const namespaceSet = new Set(opts.namespaces || PURE_NAMESPACES);
  if (!mayNeedAnnotations(code, functions, namespaceSet)) {
    return null;
  }
  const ast = parse(code, {
    errorRecovery: false,
    plugins: parserPluginsFor(opts.filename, opts.parserPlugins),
    sourceFilename: opts.filename,
    sourceType: 'module',
  });
  // Only the calls whose callee resolves to a factory this module imported
  // from Lexical (or to a declaration that says it is side-effect free) are
  // annotated; a same-named local helper is left alone.
  const factoryNames = collectFactoryNames(ast.program, functions, opts);
  const namespaceNames = collectNamespaceNames(ast.program, namespaceSet, opts);
  if (factoryNames.size === 0 && namespaceNames.size === 0) {
    return null;
  }
  /** @type {Set<number>} */
  const annotated = new Set();
  /** @type {Array<[any, {form: string}, boolean]>} */
  const inlined = [];
  /** @type {Array<any>} */
  const factoryCalls = [];
  visitModuleScopeCalls(
    ast.program,
    {functions: factoryNames, namespaces: namespaceNames},
    (node, position) => {
      if (position.namespace === true) {
        // Every call in a chain starts at the same offset, and one
        // annotation there covers the whole chain.
        if (!hasPureAnnotation(code, node.start)) {
          annotated.add(node.start);
        }
        return;
      }
      factoryCalls.push(node);
      const factory = /** @type {{inline: undefined | any, name: string}} */ (
        factoryNames.get(node.callee.name)
      );
      const spec = opts.inline === true ? factory.inline : undefined;
      if (
        spec !== undefined &&
        !position.discarded &&
        canInlineCall(node, spec)
      ) {
        inlined.push([node, spec, position.statementStart]);
      } else if (!hasPureAnnotation(code, node.start)) {
        annotated.add(node.start);
      }
    },
  );
  const offsets = Array.from(annotated);
  if (opts.strict === true) {
    const covered = new Set(annotated);
    for (const [node] of inlined) {
      covered.add(node.start);
    }
    assertArgumentsArePure(code, opts.filename, factoryCalls, covered);
  }
  if (offsets.length === 0 && inlined.length === 0) {
    return null;
  }
  const magicString = new MagicString(code);
  for (const offset of offsets) {
    magicString.appendLeft(offset, ANNOTATION);
  }
  for (const [node, spec, statementStart] of inlined) {
    inlineCall(magicString, code, node, spec, statementStart);
  }
  removeUnusedImports(
    magicString,
    code,
    ast.program,
    inlined.map(([node]) => node),
  );
  return {
    code: magicString.toString(),
    count: offsets.length,
    inlined: inlined.length,
    map:
      opts.sourceMap === false
        ? undefined
        : magicString.generateMap({hires: 'boundary', source: opts.filename}),
  };
}

/**
 * @param {undefined | RegExp | ReadonlyArray<RegExp>} value
 * @param {ReadonlyArray<RegExp>} defaultValue
 * @returns {ReadonlyArray<RegExp>}
 */
function toRegExpArray(value, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }
  return Array.isArray(value) ? value : [/** @type {RegExp} */ (value)];
}

/**
 * @param {ReadonlyArray<RegExp>} patterns
 * @param {string} id
 * @returns {boolean}
 */
function matchesAny(patterns, id) {
  return patterns.some(pattern => pattern.test(id));
}

/**
 * Strip the query string and hash a bundler may append to a module id
 * (e.g. `Foo.tsx?vue&type=script`).
 *
 * @param {string} id
 * @returns {string}
 */
function cleanModuleId(id) {
  return id.replace(/[?#][\s\S]*$/, '');
}

/**
 * @typedef {Object} PureAnnotationsOptions
 * @property {'post' | 'pre'} [enforce] Vite plugin ordering, `'post'` by
 *   default so the transform runs after TypeScript/JSX has been compiled away.
 * @property {RegExp | ReadonlyArray<RegExp>} [exclude] Module ids to skip.
 * @property {Iterable<string>} [functions] Names of the factories whose
 *   module-scope calls are annotated. Defaults to PURE_FACTORY_FUNCTIONS.
 * @property {RegExp | ReadonlyArray<RegExp>} [include] Module ids to
 *   transform, defaults to every .js/.jsx/.ts/.tsx (and .mjs/.cjs/.mts/.cts)
 *   module.
 * @property {boolean} [inline] Replace calls to the factories whose result
 *   is a trivial expression over their arguments with that expression,
 *   rather than annotating them. Off by default: it assumes the Lexical
 *   being built matches this package's version.
 * @property {ReadonlyArray<any>} [parserPlugins] Extra Babel parser
 *   plugins, for syntax the defaults do not cover.
 * @property {boolean} [relativeImports] Set to false to skip reading
 *   relatively imported modules to look for a NO_SIDE_EFFECTS declaration.
 * @property {Iterable<string>} [namespaces] Imported objects whose
 *   method calls are side-effect free, defaults to PURE_NAMESPACES.
 * @property {boolean} [sourceMap] Set to false to skip source map generation.
 * @property {RegExp | ReadonlyArray<RegExp>} [sources] Module specifiers
 *   whose exports are trusted to be the factories, defaults to `lexical` and
 *   `@lexical/*`.
 * @property {boolean} [strict] Throw when a call evaluated inside one of the
 *   definitions is not known to be side-effect free, since it pins the
 *   definition into every bundle that imports the module.
 */

/**
 * A Vite/Rollup plugin that inserts the `__PURE__` annotations that let
 * bundlers tree-shake unused Lexical extension, command, and rule
 * definitions. Use it when building Lexical (or your own extensions) from
 * TypeScript source rather than from the published `dist` bundles, which
 * already carry the annotations.
 *
 * @param {PureAnnotationsOptions} [options]
 * @returns {any} the plugin object
 */
export function pureAnnotations(options) {
  const opts = options || {};
  const functions = new Set(opts.functions || PURE_FACTORY_FUNCTIONS);
  const include = toRegExpArray(opts.include, [DEFAULT_INCLUDE]);
  const exclude = toRegExpArray(opts.exclude, []);
  return {
    enforce: opts.enforce === undefined ? 'post' : opts.enforce,
    name: '@lexical/compiler',
    /**
     * @param {string} code
     * @param {string} id
     * @returns {null | {code: string, map: any}}
     */
    transform(code, id) {
      const filename = cleanModuleId(id);
      if (!matchesAny(include, filename) || matchesAny(exclude, filename)) {
        return null;
      }
      const dependency = NODE_MODULES_RE.test(filename);
      let result = null;
      try {
        result = transformPureAnnotations(code, {
          filename,
          functions,
          inline: opts.inline,
          namespaces: opts.namespaces,
          parserPlugins: opts.parserPlugins,
          relativeImports: opts.relativeImports,
          sourceMap: opts.sourceMap,
          sources: opts.sources,
          strict: opts.strict === true && !dependency,
        });
      } catch (err) {
        if (err instanceof PureAnnotationsError && !dependency) {
          // Not something to shrug off: the module says one thing and means
          // another, or a definition cannot be tree-shaken.
          throw err;
        }
        // A module this plugin cannot parse is a module it has nothing to
        // say about; warn rather than failing the consumer's build.
        if (this && typeof this.warn === 'function') {
          this.warn(
            `@lexical/compiler could not parse ${id}, no annotations were added: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        return null;
      }
      return result === null
        ? null
        : {
            code: result.code,
            map: result.map === undefined ? null : result.map,
          };
    },
  };
}
