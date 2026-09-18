/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {defineConfig, mergeConfig, type Plugin} from 'vite';

// Imported from source (rather than by package name) so that a monorepo
// vite config loads before the packages have been built.
import {pureAnnotations} from '../../packages/lexical-compiler/src/passes/pureAnnotations.mjs';
import viteModuleResolution from './viteModuleResolution';

export default function lexicalMonorepoPlugin(): Plugin[] {
  return [
    {
      config(config, env) {
        return mergeConfig(
          defineConfig({
            define: {
              __DEV__: env.mode !== 'production',
              'process.env.IS_PREACT': process.env.IS_PREACT,
              'process.env.LEXICAL_VERSION': JSON.stringify(
                `${process.env.npm_package_version}+git`,
              ),
            },
            resolve: {
              alias: viteModuleResolution(
                env.mode === 'production'
                  ? 'production'
                  : env.command === 'serve'
                    ? 'source'
                    : 'development',
                env.isSsrBuild,
              ),
            },
          }),
          config,
        );
      },
      name: 'lexicalMonorepoPlugin',
    },
    // Monorepo builds that resolve Lexical to its TypeScript source need the
    // /* @__PURE__ */ annotations injected, exactly as consumers of the
    // `source` export condition do. Harmless when the aliases point at
    // `dist` instead: those bundles are already annotated and the transform
    // is idempotent. `inline` is safe to turn on here because the Lexical
    // being built is always this checkout's.
    pureAnnotations({inline: true, strict: true}),
  ];
}
