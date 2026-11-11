/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import * as helperModuleImports from '@babel/helper-module-imports';
import prettier from '@prettier/sync';
import fs from 'fs-extra';

import ErrorMap from './ErrorMap.mjs';
import evalToString from './evalToString.mjs';

/** @type {Map<string, ErrorMap>} */
const errorMaps = new Map();
/**
 * Get a module-global ErrorMap instance so that all instances of this
 * plugin are working with the same data structure. Typically there is
 * at most one entry in this map (`${import.meta.dirname}/codes.json`).
 *
 * @param {string} filepath
 * @returns {ErrorMap}
 */
function getErrorMap(filepath) {
  let errorMap = errorMaps.get(filepath);
  if (!errorMap) {
    const prettierConfig = {
      ...(prettier.resolveConfig(import.meta.filename) || {}),
      filepath,
    };
    errorMap = new ErrorMap(fs.readJsonSync(filepath), newErrorMap =>
      fs.writeFileSync(
        filepath,
        prettier.format(JSON.stringify(newErrorMap), prettierConfig),
      ),
    );
    errorMaps.set(filepath, errorMap);
  }
  return errorMap;
}

/**
 * @typedef {Object} TransformErrorMessagesOptions
 * @property {string} errorCodesPath
 * @property {boolean} extractCodes
 * @property {boolean} noMinify
 */

const errorExpressions = [
  {
    dev: 'createDevError',
    name: 'createError',
    prod: 'createProdError',
    prodNoCode: 'createDevError',
  },
  {
    dev: 'formatDevErrorMessage',
    name: 'invariant',
    prod: 'formatProdErrorMessage',
    prodNoCode: 'formatDevErrorMessage',
  },
  {
    dev: 'formatDevErrorMessage',
    name: 'devInvariant',
    prod: 'formatProdWarningMessage',
    prodNoCode: 'formatDevWarningMessage',
  },
];

/**
 * @param {import('@babel/core')} babel
 * @param {Partial<TransformErrorMessagesOptions>} opts
 * @returns {{visitor: {CallExpression: (path: any, file: any) => void}}} a Babel plugin (path/file are untyped Babel AST nodes)
 */
export default function transformErrorMessages(babel, opts) {
  const t = babel.types;
  const errorMap = getErrorMap(
    (opts && opts.errorCodesPath) || `${import.meta.dirname}/codes.json`,
  );
  return {
    visitor: {
      CallExpression(path, file) {
        const node = path.node;
        const {extractCodes, noMinify} =
          /** @type Partial<TransformErrorMessagesOptions> */ (file.opts);
        const callee = path.get('callee');
        for (const {name, dev, prod, prodNoCode} of errorExpressions) {
          const isErrorFactory = name === 'createError';
          if (
            isErrorFactory
              ? callee.isIdentifier() &&
                (callee.referencesImport(
                  '@lexical/internal/createError',
                  'default',
                ) ||
                  callee.referencesImport(
                    '@lexical/internal/createError.js',
                    'default',
                  ))
              : callee.isIdentifier({name})
          ) {
            // Turns this code:
            //
            // invariant(condition, 'A %s message that contains %s', adj, noun);
            //
            // into something equivalent to this:
            //
            // if (!condition) {
            //   if (__DEV__ || ERR_CODE === undefined) {
            //     formatDevErrorMessage(`A ${adj} message that contains ${noun}`);
            //   } else {
            //     formatProdErrorMessage(ERR_CODE, adj, noun)
            //   };
            // }
            //
            // where ERR_CODE is an error code: a unique identifier (a number
            // string) that references a verbose error message. The mapping is
            // stored in `scripts/error-codes/codes.json`.
            const messageIndex = isErrorFactory ? 0 : 1;
            const condition = node.arguments[0];
            const errorMsgLiteral = evalToString(node.arguments[messageIndex]);
            const errorMsgExpressions = Array.from(
              node.arguments.slice(messageIndex + 1),
            );
            const errorMsgQuasis = errorMsgLiteral
              .split('%s')
              .map(raw => t.templateElement({cooked: String.raw({raw}), raw}));

            // Outputs:
            //   `A ${adj} message that contains ${noun}`;
            const devMessage = t.templateLiteral(
              errorMsgQuasis,
              errorMsgExpressions,
            );

            const parentStatementPath = path.parentPath;
            if (
              !isErrorFactory &&
              parentStatementPath.type !== 'ExpressionStatement'
            ) {
              throw path.buildCodeFrameError(
                `${name}() cannot be called from expression context. Move the call to its own statement.`,
              );
            }

            // We extract the prodErrorId even if we are not using it
            // so we can extractCodes in a non-production build.
            let prodErrorId = errorMap.getOrAddToErrorMap(
              errorMsgLiteral,
              extractCodes ?? false,
            );

            /** @type {import('@babel/core').types.CallExpression} */
            let callExpression;
            if (noMinify || prodErrorId === undefined) {
              // Error minification is disabled for this build.
              //
              // Outputs:
              //   if (!condition) {
              //     formatDevErrorMessage(`A ${adj} message that contains ${noun}`);
              //   }
              const moduleName =
                prodErrorId === undefined && !noMinify ? prodNoCode : dev;
              const formatDevErrorMessageIdentifier =
                helperModuleImports.addDefault(
                  path,
                  `@lexical/internal/${moduleName}`,
                  {nameHint: moduleName},
                );
              callExpression = t.callExpression(
                formatDevErrorMessageIdentifier,
                [devMessage],
              );
            } else {
              // Error minification enabled for this build.
              //
              // Outputs:
              // if (!condition) {
              //   formatProdErrorMessage(ERR_CODE, adj, noun)
              // }

              // Import ReactErrorProd
              const formatProdErrorMessageIdentifier =
                helperModuleImports.addDefault(
                  path,
                  `@lexical/internal/${prod}`,
                  {nameHint: prod},
                );

              // Outputs:
              //   formatProdErrorMessage(ERR_CODE, adj, noun);
              callExpression = t.callExpression(
                formatProdErrorMessageIdentifier,
                [t.numericLiteral(prodErrorId), ...errorMsgExpressions],
              );
            }

            if (isErrorFactory) {
              // Preserve expression evaluation order and let the caller decide
              // whether to throw, warn, or otherwise report the error.
              path.replaceWith(callExpression);
            } else {
              parentStatementPath.replaceWith(
                t.ifStatement(
                  t.unaryExpression('!', condition),
                  t.blockStatement([t.expressionStatement(callExpression)]),
                ),
              );
            }

            if (!noMinify && prodErrorId === undefined) {
              // There is no error code for this message. Add an inline comment
              // that flags this as an unminified error. This allows the build
              // to proceed, while also allowing a post-build linter to detect it.
              //
              // Outputs:
              //   /* FIXME (minify-errors-in-prod): Unminified error message in production build! */
              //   if (!condition) {
              //     formatDevErrorMessage(`A ${adj} message that contains ${noun}`);
              //   }
              (isErrorFactory ? path : parentStatementPath).addComment(
                'leading',
                'FIXME (minify-errors-in-prod): Unminified error message in production build!',
              );
            }
            return;
          }
        }
      },
    },
  };
}
