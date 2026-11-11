/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {parse} from '@babel/parser';
import MagicString from 'magic-string';
import * as fs from 'node:fs';
import {createRequire} from 'node:module';
import * as path from 'node:path';

import {parserPluginsFor} from './parserPlugins.mjs';

/** @typedef {{source: string, imported: string}} ImportTarget */
/** @typedef {import('../SubpathImports').SubpathImportsOptions} Options */
/** @typedef {import('../SubpathImports').SubpathImportsPlugin} Plugin */

/** @param {string} filename */
const withoutExtension = filename => filename.replace(/\.[cm]?[jt]sx?$/, '');

/** @param {any} node @returns {string} */
const specifierName = node =>
  node.type === 'Identifier' ? node.name : node.value;

/** @param {any} node */
const isTypeOnly = node =>
  node.importKind === 'type' ||
  node.importKind === 'typeof' ||
  node.exportKind === 'type';

/** @param {string} name */
const quotedName = name =>
  /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);

/** @param {string} code @param {string} filename @param {Options['parserPlugins']} extraPlugins */
function parseModule(code, filename, extraPlugins) {
  const options = {
    // CommonJS wrappers permit top-level return/new.target, including in .js
    // dependencies. Leave final syntax validation to the downstream compiler.
    allowNewTargetOutsideFunction: !/\.m[jt]s$/.test(filename),
    allowReturnOutsideFunction: !/\.m[jt]s$/.test(filename),
    createImportExpressions: true,
    plugins: parserPluginsFor(filename, extraPlugins, [
      'decorators',
      'decoratorAutoAccessors',
    ]),
    sourceType: /** @type {const} */ ('unambiguous'),
  };
  try {
    return parse(code, options);
  } catch (error) {
    // Legacy TypeScript parameter decorators are not part of standard
    // decorators. Both forms must survive this pass before transpilation.
    options.plugins = options.plugins.map(plugin =>
      (Array.isArray(plugin) ? plugin[0] : plugin) === 'decorators'
        ? 'decorators-legacy'
        : plugin,
    );
    try {
      return parse(code, options);
    } catch {
      // A retry should not replace the original diagnostic for invalid code.
      throw error;
    }
  }
}

/**
 * Locate the package without requiring a package.json export or evaluating
 * its entry point. Absolute package.json paths also support unbuilt checkouts.
 * @param {string} name
 * @param {string} root
 */
function packageFile(name, root) {
  if (path.isAbsolute(name) || name.startsWith('.')) {
    return path.resolve(root, name);
  }
  const require = createRequire(path.resolve(root, 'package.json'));
  let dir = path.dirname(require.resolve(name));
  while (true) {
    const file = path.join(dir, 'package.json');
    if (
      fs.existsSync(file) &&
      JSON.parse(fs.readFileSync(file, 'utf8')).name === name
    ) {
      return file;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`Cannot find package.json for ${name}`);
    }
    dir = parent;
  }
}

/** @param {Options} options */
function readImports(options) {
  /** @type {Map<string, string>} */
  const modules = new Map();
  /** @type {Map<string, string>} */
  const sources = new Map();
  /** @type {Map<string, Map<string, ImportTarget>>} */
  const barrels = new Map();
  /** @type {Map<string, Set<string>>} */
  const stars = new Map();
  const files = new Set();
  const roots = [];
  for (const name of options.packages || ['@lexical/extension']) {
    const file = packageFile(name, options.root || process.cwd());
    files.add(file);
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Bypassing a barrel also bypasses its unused re-exported modules. Only
    // do that when the package explicitly promises they have no side effects.
    if (pkg.sideEffects !== false) {
      continue;
    }
    const entries = Object.entries(pkg.exports || {}).filter(
      ([key, value]) =>
        key.startsWith('.') &&
        typeof value === 'object' &&
        value !== null &&
        'source' in value,
    );
    // Single-entry packages have no public subpaths to target.
    if (entries.filter(([key]) => !key.endsWith('.js')).length < 2) {
      continue;
    }
    roots.push(pkg.name);
    for (const [key, entry] of entries) {
      const source = path.resolve(
        path.dirname(file),
        /** @type {{source: string}} */ (entry).source,
      );
      const moduleName = `${pkg.name}${key.slice(1)}`;
      sources.set(moduleName, source);
      if (!key.endsWith('.js')) {
        modules.set(withoutExtension(source), moduleName);
      }
    }
  }
  /** @param {string} source @param {string} filename */
  const resolve = (source, filename) => {
    if (source.startsWith('.')) {
      const resolved = withoutExtension(
        path.resolve(path.dirname(filename), source),
      );
      return (
        modules.get(resolved) ||
        modules.get(path.join(resolved, 'index')) ||
        source
      );
    }
    return source;
  };
  /** @param {string} name */
  const read = name => {
    const filename = sources.get(name);
    if (!filename) {
      throw new Error(
        `No public source entry for ${name}; use explicit named re-exports`,
      );
    }
    files.add(filename);
    return {
      body: parseModule(
        fs.readFileSync(filename, 'utf8'),
        filename,
        options.parserPlugins,
      ).program.body,
      filename,
    };
  };
  /**
   * Collect names for export * without following bindings into private
   * implementation files. Reject unsupported/ambiguous stars explicitly.
   * @param {string} name
   */
  const starNames = name => {
    // A namespace containing only types is erased by the TypeScript compiler.
    /** @param {any} node @returns {boolean} */
    const hasRuntimeValue = node => {
      if (!node || node.declare || isTypeOnly(node)) {
        return false;
      }
      if (node.type === 'ExportNamedDeclaration') {
        return hasRuntimeValue(node.declaration);
      }
      if (node.type === 'TSModuleDeclaration') {
        return hasRuntimeValue(node.body);
      }
      if (node.type === 'TSModuleBlock') {
        return node.body.some(hasRuntimeValue);
      }
      return (
        node.type === 'TSEnumDeclaration' ||
        node.type === 'TSImportEqualsDeclaration' ||
        (!node.type.startsWith('TS') && node.type !== 'EmptyStatement')
      );
    };
    const {body} = read(name);
    // A bare `export {Thing}` can refer to an erased local declaration or
    // type import. Combine merged declarations: a class/interface binding,
    // for example, still has a runtime value regardless of declaration order.
    const bindings = new Map();
    /** @param {any} pattern @param {boolean} runtime */
    const addBinding = (pattern, runtime) => {
      if (!pattern) {
        return;
      }
      if (pattern.type === 'Identifier') {
        bindings.set(
          pattern.name,
          runtime || bindings.get(pattern.name) || false,
        );
      } else if (pattern.type === 'ObjectPattern') {
        for (const prop of pattern.properties) {
          addBinding(
            prop.type === 'RestElement' ? prop.argument : prop.value,
            runtime,
          );
        }
      } else if (pattern.type === 'ArrayPattern') {
        for (const item of pattern.elements) {
          addBinding(item, runtime);
        }
      } else if (pattern.type === 'RestElement') {
        addBinding(pattern.argument, runtime);
      } else if (pattern.type === 'AssignmentPattern') {
        addBinding(pattern.left, runtime);
      }
    };
    for (const statement of body) {
      const node =
        statement.type === 'ExportNamedDeclaration' ||
        statement.type === 'ExportDefaultDeclaration'
          ? statement.declaration
          : statement;
      if (!node) {
        continue;
      }
      if (node.type === 'ImportDeclaration') {
        for (const spec of node.specifiers) {
          addBinding(spec.local, !isTypeOnly(node) && !isTypeOnly(spec));
        }
      } else if (node.type === 'VariableDeclaration') {
        for (const item of node.declarations) {
          addBinding(item.id, hasRuntimeValue(node));
        }
      } else if ('id' in node) {
        addBinding(node.id, hasRuntimeValue(node));
      }
    }
    const names = new Set();
    const values = new Set();
    for (const node of body) {
      if (node.type === 'ExportAllDeclaration') {
        throw new Error(`${name}: use explicit re-exports for nested stars`);
      }
      if (node.type !== 'ExportNamedDeclaration') {
        continue;
      }
      for (const spec of node.specifiers) {
        const exported = specifierName(spec.exported);
        names.add(exported);
        if (
          node.exportKind !== 'type' &&
          (spec.type !== 'ExportSpecifier' ||
            (spec.exportKind !== 'type' &&
              (node.source ||
                bindings.get(specifierName(spec.local)) !== false)))
        ) {
          values.add(exported);
        }
      }
      const decl = node.declaration;
      if (decl && decl.type === 'VariableDeclaration') {
        for (const item of decl.declarations) {
          if (item.id.type !== 'Identifier') {
            throw new Error(
              `${name}: use explicit re-exports for destructuring`,
            );
          }
          names.add(item.id.name);
          if (node.exportKind !== 'type' && !decl.declare) {
            values.add(item.id.name);
          }
        }
      } else if (
        decl &&
        'id' in decl &&
        decl.id &&
        decl.id.type === 'Identifier'
      ) {
        names.add(decl.id.name);
        if (
          node.exportKind !== 'type' &&
          !('declare' in decl && decl.declare) &&
          (decl.type === 'ClassDeclaration' ||
            decl.type === 'FunctionDeclaration' ||
            decl.type === 'TSEnumDeclaration' ||
            (decl.type === 'TSModuleDeclaration' && hasRuntimeValue(decl)))
        ) {
          values.add(decl.id.name);
        }
      }
    }
    names.delete('default');
    values.delete('default');
    stars.set(name, values);
    return names;
  };
  for (const name of roots) {
    if (!sources.has(name)) {
      continue;
    }
    const {filename, body} = read(name);
    // Do not bypass root entry points with executable initialization (e.g.
    // @lexical/headless). Only transparent re-export barrels are eligible.
    if (
      !body.length ||
      !body.every(
        node =>
          (node.type === 'ExportNamedDeclaration' ||
            node.type === 'ExportAllDeclaration') &&
          node.source,
      )
    ) {
      continue;
    }
    /** @type {Map<string, ImportTarget>} */
    const exports = new Map();
    for (const node of body) {
      if (
        node.type !== 'ExportNamedDeclaration' &&
        node.type !== 'ExportAllDeclaration'
      ) {
        continue;
      }
      if (!node.source || (node.attributes && node.attributes.length)) {
        throw new Error(
          `${name}: expected only re-exports without import attributes`,
        );
      }
      const target = resolve(node.source.value, filename);
      if (target.startsWith('.')) {
        throw new Error(`${name}: ${target} is not a public subpath`);
      }
      if (node.type === 'ExportAllDeclaration') {
        for (const imported of starNames(target)) {
          if (exports.has(imported)) {
            throw new Error(
              `${name}: use explicit re-exports for duplicate ${imported}`,
            );
          }
          exports.set(imported, {imported, source: target});
        }
      } else {
        for (const spec of node.specifiers) {
          if (spec.type !== 'ExportSpecifier') {
            throw new Error(
              `${name}: use named re-exports instead of namespaces`,
            );
          }
          exports.set(specifierName(spec.exported), {
            imported: specifierName(spec.local),
            source: target,
          });
        }
      }
    }
    barrels.set(name, exports);
  }
  const signature = JSON.stringify([
    [...modules],
    [...barrels].map(([name, bindings]) => [name, [...bindings]]),
    [...stars].map(([name, values]) => [name, [...values]]),
  ]);
  return {barrels, files, resolve, signature, stars};
}

/**
 * Replace imports of transparent package barrels with their public subpaths.
 * The mapping comes from the installed package's source exports, so it stays
 * aligned with that version, including aliases and compatibility re-exports.
 * @param {Options} [options]
 * @returns {Plugin}
 */
export function subpathImports(options = {}) {
  /** @type {ReturnType<typeof readImports> | undefined} */
  let imports;
  let mappingChanged = true;
  const transformedIds = new Set();
  return {
    buildStart() {
      const previous = imports;
      imports = readImports(options);
      mappingChanged = !previous || previous.signature !== imports.signature;
      for (const file of imports.files) {
        this.addWatchFile(file);
      }
    },
    enforce: 'pre',
    handleHotUpdate({file, modules, server, timestamp}) {
      if (!imports || !imports.files.has(path.resolve(file))) {
        return;
      }
      const previous = imports;
      imports = readImports(options);
      server.watcher.add([...imports.files]);
      if (previous.signature === imports.signature) {
        return;
      }
      // Vite serve does not rerun buildStart or shouldTransformCachedModule.
      // Rewrites have hidden the barrel from its dependency graph, so include
      // cached consumers in HMR and invalidate their transforms explicitly.
      const affected = new Set(modules);
      for (const id of transformedIds) {
        const module = server.moduleGraph.getModuleById(id);
        if (module) {
          server.moduleGraph.invalidateModule(
            module,
            undefined,
            timestamp,
            true,
          );
          affected.add(module);
        } else {
          transformedIds.delete(id);
        }
      }
      return [...affected];
    },
    name: '@lexical/compiler/subpath-imports',
    shouldTransformCachedModule() {
      // Watching the barrel triggers a rebuild, but consumers' source text
      // stays unchanged. Discard their cached rewrites when targets change.
      return mappingChanged;
    },
    transform(code, id) {
      const filename = id.replace(/[?#].*$/, '');
      if (!/\.[cm]?[jt]sx?$/.test(filename) || filename.endsWith('.d.ts')) {
        return null;
      }
      imports ||= readImports(options);
      transformedIds.add(id);
      const {barrels, resolve, stars} = imports;
      const ast = parseModule(code, filename, options.parserPlugins);
      const output = new MagicString(code);
      let changed = false;
      /** @param {string} source @param {string} imported */
      const targetFor = (source, imported) => {
        const seen = new Set();
        while (barrels.has(source)) {
          const key = `${source}:${imported}`;
          if (seen.has(key)) {
            throw new Error(`Circular barrel re-export: ${key}`);
          }
          seen.add(key);
          const target = /** @type {Map<string, ImportTarget>} */ (
            barrels.get(source)
          ).get(imported);
          if (!target) {
            throw new Error(`${filename}: unknown barrel export ${key}`);
          }
          ({source, imported} = target);
        }
        return {imported, source};
      };
      /** @param {string} source */
      const unsupported = source => {
        if (options.strict) {
          throw new Error(
            `${filename}: use named subpath imports instead of the ${source} barrel`,
          );
        }
      };
      /** @param {any} node @param {string} replacement */
      const replace = (node, replacement) => {
        output.overwrite(node.start, node.end, replacement);
        changed = true;
      };
      /** @param {any} node */
      const walk = node => {
        if (!node || typeof node !== 'object') {
          return;
        }
        if (isTypeOnly(node)) {
          return;
        }
        if (
          node.source &&
          (node.type === 'ImportDeclaration' ||
            node.type === 'ExportNamedDeclaration' ||
            node.type === 'ExportAllDeclaration')
        ) {
          const source = resolve(node.source.value, filename);
          const barrel = barrels.get(source);
          if (!barrel) {
            // Explicit exports avoid runtime namespace enumeration in
            // consumers and let Rollup enumerate the barrel's own exports.
            const names = stars.get(source);
            if (
              node.type === 'ExportAllDeclaration' &&
              names &&
              !(node.attributes && node.attributes.length)
            ) {
              replace(
                node,
                `export {${[...names].map(quotedName).join(', ')}} from ${JSON.stringify(source)};`,
              );
              return;
            }
            if (source !== node.source.value) {
              replace(node.source, JSON.stringify(source));
            }
            return;
          }
          if (
            (node.attributes && node.attributes.length) ||
            node.type === 'ExportAllDeclaration' ||
            !node.specifiers.length ||
            node.specifiers.some(
              /** @param {any} spec */ spec =>
                !isTypeOnly(spec) &&
                (spec.type.includes('Namespace') ||
                  (!barrel.has('default') &&
                    (spec.type === 'ImportDefaultSpecifier' ||
                      (spec.imported &&
                        specifierName(spec.imported) === 'default') ||
                      (spec.local &&
                        specifierName(spec.local) === 'default')))),
            )
          ) {
            unsupported(source);
            return;
          }
          const isImport = node.type === 'ImportDeclaration';
          const statements = node.specifiers.map(
            /** @param {any} spec */ spec => {
              if (isTypeOnly(spec)) {
                return `${isImport ? 'import' : 'export'} {${code.slice(spec.start, spec.end)}} from ${JSON.stringify(node.source.value)};`;
              }
              const name =
                spec.type === 'ImportDefaultSpecifier'
                  ? 'default'
                  : specifierName(isImport ? spec.imported : spec.local);
              const target = targetFor(source, name);
              const local = isImport ? spec.local : spec.exported;
              const localName =
                local.type === 'Identifier'
                  ? local.name
                  : JSON.stringify(local.value);
              const imported = quotedName(target.imported);
              return `${isImport ? 'import' : 'export'} {${imported}${imported === localName ? '' : ` as ${localName}`}} from ${JSON.stringify(target.source)};`;
            },
          );
          replace(node, statements.join('\n'));
          return;
        }
        if (
          node.type === 'ImportExpression' ||
          (node.type === 'TSImportEqualsDeclaration' &&
            node.moduleReference.type === 'TSExternalModuleReference') ||
          (node.type === 'CallExpression' &&
            node.callee.type === 'Identifier' &&
            node.callee.name === 'require')
        ) {
          const arg =
            node.type === 'ImportExpression'
              ? node.source
              : node.type === 'TSImportEqualsDeclaration'
                ? node.moduleReference.expression
                : node.arguments[0];
          const value =
            arg &&
            (arg.type === 'StringLiteral'
              ? arg.value
              : arg.type === 'TemplateLiteral' && !arg.expressions.length
                ? arg.quasis[0].value.cooked
                : undefined);
          if (typeof value === 'string') {
            const source = resolve(value, filename);
            if (barrels.has(source)) {
              unsupported(source);
            } else if (source !== value) {
              replace(arg, JSON.stringify(source));
            }
          }
        }
        for (const [key, value] of Object.entries(node)) {
          if (key === 'loc' || key.endsWith('Comments') || key === 'comments') {
            continue;
          }
          if (Array.isArray(value)) {
            value.forEach(walk);
          } else if (value && typeof value === 'object') {
            walk(value);
          }
        }
      };
      ast.program.body.forEach(walk);
      return changed
        ? {
            code: output.toString(),
            map: output.generateMap({
              hires: true,
              includeContent: true,
              source: filename,
            }),
          }
        : null;
    },
  };
}
