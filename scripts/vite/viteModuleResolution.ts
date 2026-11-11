/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {
  ModuleExportEntry,
  NpmModuleExportEntry,
  PackageMetadata,
} from '../shared/PackageMetadata.mjs';
import type {Alias} from 'vite';

import * as fs from 'node:fs';
import * as path from 'node:path';

import {packagesManager} from '../shared/packagesManager.mjs';

/**
 * Escape a string for exact match in a RegExp
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions#escaping
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

function entryFindRegExp(name: string): RegExp {
  return new RegExp(`^${escapeRegExp(name)}$`);
}

function resolveSource(
  pkg: PackageMetadata,
  sourceFileName: string,
  isSsrBuild = false,
): string {
  if (!isSsrBuild) {
    const browserSourceFileName = pkg.resolve(
      'src',
      sourceFileName.replace(/(\.tsx?)$/, '.browser$1'),
    );
    if (fs.existsSync(browserSourceFileName)) {
      return browserSourceFileName;
    }
  }
  return pkg.resolve('src', sourceFileName);
}

// Only public packages need aliasing here. The former private `shared`
// module space is now the public `@lexical/internal` package (handled by
// the loop below), and there are no remaining private packages whose
// modules are imported by name from the vite-built apps/examples.
const sourceModuleResolution = (isSsrBuild = false) => {
  function toAlias(pkg: PackageMetadata, entry: ModuleExportEntry) {
    return {
      find: entryFindRegExp(entry.name),
      replacement: resolveSource(pkg, entry.sourceFileName, isSsrBuild),
    };
  }

  return packagesManager
    .getPublicPackages()
    .flatMap(pkg =>
      pkg.getExportedNpmModuleEntries().map(toAlias.bind(null, pkg)),
    );
};

const distModuleResolution = (
  environment: 'development' | 'production',
  isSsrBuild = false,
) => {
  return packagesManager.getPublicPackages().flatMap(pkg =>
    pkg
      .getNormalizedNpmModuleExportEntries()
      .map((entry: NpmModuleExportEntry) => {
        const [name, moduleExports] = entry;
        // Paths in the exports map are now relative to the package root
        // and already include the `./dist/` segment, so just resolve
        // them against the package directory.
        const replacements = ([environment, 'default'] as const).flatMap(
          condition =>
            [
              !isSsrBuild &&
                moduleExports.browser &&
                moduleExports.browser[condition],
              moduleExports[condition],
            ].flatMap(fn => (fn ? [pkg.resolve(fn)] : [])),
        );
        const distRel = path.relative(pkg.resolve('.'), replacements[1] || '');
        const replacement = replacements.find(fs.existsSync.bind(fs));
        if (!replacement) {
          throw new Error(
            `ERROR: Missing ${distRel}. Did you run \`pnpm run build\` in the monorepo first?`,
          );
        }
        return {
          find: entryFindRegExp(name),
          replacement,
        };
      }),
  );
};

export default function moduleResolution(
  environment: 'source' | 'development' | 'production',
  isSsrBuild = false,
): Alias[] {
  return environment === 'source'
    ? sourceModuleResolution(isSsrBuild)
    : distModuleResolution(environment, isSsrBuild);
}
