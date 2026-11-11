/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {SourceMap} from 'magic-string';

import * as impl from './passes/subpathImports.mjs';

export interface SubpathImportsOptions {
  /** Package names or paths to package.json files. Defaults to ['@lexical/extension']. */
  packages?: readonly string[];
  /** Extra @babel/parser plugins, for syntax the defaults do not cover. */
  parserPlugins?: readonly unknown[];
  /** Resolve package names from this directory. Defaults to process.cwd(). */
  root?: string;
  /** Reject runtime barrel access that cannot be narrowed (namespace, dynamic, require, side-effect or star imports). Defaults to false. */
  strict?: boolean;
}

/** Structural interface compatible with Rollup and Vite, without a runtime dependency on either. */
export interface SubpathImportsPlugin {
  name: string;
  enforce: 'pre';
  buildStart(this: {addWatchFile(file: string): void}): void;
  handleHotUpdate<Module>(context: {
    file: string;
    modules: Module[];
    timestamp: number;
    server: {
      watcher: {add(files: string[]): unknown};
      moduleGraph: {
        getModuleById(id: string): Module | undefined;
        invalidateModule(
          module: Module,
          seen?: Set<Module>,
          timestamp?: number,
          isHmr?: boolean,
        ): void;
      };
    };
  }): Module[] | void;
  shouldTransformCachedModule(): boolean;
  transform(
    code: string,
    id: string,
  ): {
    code: string;
    map: SourceMap;
  } | null;
}

/** Rewrite named barrel imports to public subpaths before dependency resolution. */
export const subpathImports: (
  options?: SubpathImportsOptions,
) => SubpathImportsPlugin = impl.subpathImports;
