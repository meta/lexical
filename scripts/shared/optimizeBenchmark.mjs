/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import terser from '@rollup/plugin-terser';
import {rollup} from 'rollup';
import ts from 'typescript';

import {productionTerserOptions} from './buildOptions.mjs';

/**
 * Optimize an esbuild benchmark bundle before importing or timing it.
 * @param {string} source
 */
export async function optimizeBenchmark(source) {
  const file = ts.createSourceFile(
    'benchmark.js',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  /** @type {Record<string, false>} */
  const constants = {};
  // esbuild gives module-local __DEV__ bindings unique names. Only treat
  // top-level, literal-false bindings as compile-time constants.
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        /^__DEV__\d*$/.test(declaration.name.text)
      ) {
        if (
          !declaration.initializer ||
          declaration.initializer.kind !== ts.SyntaxKind.FalseKeyword
        ) {
          throw new Error(
            `Unverified development constant: ${declaration.name.text}`,
          );
        }
        constants[declaration.name.text] = false;
      }
    }
  }
  /** @param {ts.Node} node */
  function verify(node) {
    if (ts.isIdentifier(node) && /^__DEV__\d*$/.test(node.text)) {
      if (!(node.text in constants)) {
        throw new Error(`Unverified development constant: ${node.text}`);
      }
      const parent = node.parent;
      if (
        (ts.isBinaryExpression(parent) &&
          parent.left === node &&
          parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
        ts.isPostfixUnaryExpression(parent) ||
        (ts.isPrefixUnaryExpression(parent) &&
          (parent.operator === ts.SyntaxKind.PlusPlusToken ||
            parent.operator === ts.SyntaxKind.MinusMinusToken))
      ) {
        throw new Error(`Mutable development constant: ${node.text}`);
      }
    }
    ts.forEachChild(node, verify);
  }
  verify(file);
  const bundle = await rollup({
    input: 'benchmark',
    plugins: [
      {
        load: id => (id === 'benchmark' ? source : null),
        name: 'benchmark-source',
        resolveId: id => (id === 'benchmark' ? id : null),
      },
      terser({
        ...productionTerserOptions,
        compress: {...productionTerserOptions.compress, global_defs: constants},
        // Reserve these names so mangling cannot hide a failed elimination.
        mangle: {reserved: Object.keys(constants)},
        module: true,
      }),
    ],
    treeshake: false,
  });
  try {
    const {output} = await bundle.generate({format: 'esm'});
    const chunk = output[0];
    if (output.length !== 1 || chunk.type !== 'chunk') {
      throw new Error('Expected one optimized benchmark chunk');
    }
    if (/\b__DEV__\d*\b/.test(chunk.code)) {
      throw new Error('Development constants remain in optimized benchmark');
    }
    return {
      code: chunk.code,
      eliminatedDevConstants: Object.keys(constants).length,
    };
  } finally {
    await bundle.close();
  }
}
