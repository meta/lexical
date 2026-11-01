/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A bare Metro project: the same resolver React Native uses, minus React
// Native itself. `metro-babel-transformer` and `getTransformOptions` mirror
// the React Native template so the packages go through the same transforms.
//
// With LEXICAL_SINGLE_VARIANT=1 the resolver adds the `development` or
// `production` export condition for the Lexical packages, as documented in
// the website FAQ ("Which module formats are published?"), so Metro resolves
// one build instead of the `default` fork module that carries both.
const singleVariant = process.env.LEXICAL_SINGLE_VARIANT === '1';

module.exports = {
  reporter: {update() {}},
  resolver: {
    // Metro's default block list excludes every path containing
    // `/__tests__/`, which is where this fixture lives (an empty list falls
    // back to that default, so this is a pattern that never matches).
    blockList: /(?!)/,
    ...(singleVariant
      ? {
          resolveRequest: (context, moduleName, platform) =>
            context.resolveRequest(
              /^(lexical|@lexical\/)/.test(moduleName)
                ? {
                    ...context,
                    unstable_conditionNames: [
                      ...context.unstable_conditionNames,
                      context.dev ? 'development' : 'production',
                    ],
                  }
                : context,
              moduleName,
              platform,
            ),
        }
      : {}),
  },
  transformer: {
    babelTransformerPath: require.resolve('metro-babel-transformer'),
    getTransformOptions: async () => ({
      transform: {experimentalImportSupport: false, inlineRequires: true},
    }),
  },
};
