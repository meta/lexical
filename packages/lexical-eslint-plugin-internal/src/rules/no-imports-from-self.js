/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// From: https://github.com/payloadcms/payload/blob/main/packages/eslint-plugin/customRules/no-imports-from-self.js

import fs from 'node:fs';
import path from 'node:path';

import {PackageMetadata} from '../../../../scripts/shared/PackageMetadata.mjs';

/**
 * @param {string} fn
 * @returns {string}
 */
function removeExtension(fn) {
  return fn.replace(/\.m?(ts|js)x?$/, '');
}

/**
 * @type {Map<string, PackageMetadata>}
 */
const packageMetadataCache = new Map();

/**
 * @param {string} startDir
 * @returns {PackageMetadata | null}
 */
function getNearestPackageJsonMetadata(startDir) {
  /** @type {Set<string>} */
  const dirs = new Set();
  /** @type {PackageMetadata | null} */
  let packageMetadata = null;
  for (
    let currentDir = startDir;
    !dirs.has(currentDir) && currentDir.length > 0;
    currentDir = path.dirname(currentDir)
  ) {
    packageMetadata = packageMetadataCache.get(currentDir);
    if (!packageMetadata) {
      dirs.add(currentDir);
      const pkgPath = path.join(currentDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        packageMetadata = new PackageMetadata(pkgPath);
      }
    }
    if (packageMetadata) {
      for (const dir of dirs) {
        packageMetadataCache.set(dir, packageMetadata);
      }
      break;
    }
  }
  return packageMetadata;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  create(context) {
    /** @type {PackageMetadata | null} */
    let packageMetadata = null;

    return {
      ImportDeclaration(node) {
        // Skip type-only imports
        if (node.importKind === 'type' || node.importKind === 'typeof') {
          return;
        }

        const importPath = node.source.value;
        if (!packageMetadata) {
          packageMetadata = getNearestPackageJsonMetadata(
            path.dirname(context.filename),
          );
        }

        // Skip if package is private
        if (!packageMetadata || packageMetadata.isPrivate()) {
          return;
        }

        const packagesMatch = /^packages\/([^/]+)\//.exec(importPath);
        if (packagesMatch) {
          const invalidPackage = getNearestPackageJsonMetadata(
            packagesMatch[1],
          );
          if (invalidPackage && !invalidPackage.isPrivate()) {
            const data = {
              moduleName: `'${importPath}'`,
              suggestedModuleName: `'${invalidPackage.getNpmName()}'`,
            };
            /** @type {import('eslint').Rule.ReportFixer} */
            const fix = fixer =>
              fixer.replaceText(node.source, data.suggestedModuleName);
            context.report({
              data,
              fix,
              messageId: 'packagesImport',
              node,
              suggest: [{data, fix, messageId: 'packagesImportSuggestion'}],
            });
          } else {
            context.report({
              data: {moduleName: `'${importPath}'`},
              messageId: 'packagesImport',
              node,
            });
          }
          return;
        }

        const packageName = packageMetadata.getNpmName();
        const reportSelfImport = () => {
          const data = {
            moduleName: `'${importPath}'`,
            suggestedModuleName: `'.${importPath.substring(
              packageName.length,
            )}'`,
          };
          /** @type {import('eslint').Rule.ReportFixer} */
          const fix = fixer =>
            fixer.replaceText(node.source, data.suggestedModuleName);
          context.report({
            data,
            fix,
            messageId: 'moduleSelfImport',
            node,
            suggest: [{data, fix, messageId: 'moduleSelfImportSuggestion'}],
          });
        };
        if (importPath === packageName) {
          // Self-import
          reportSelfImport();
        } else if (importPath.startsWith(`${packageName}/`)) {
          // Import from subpath export => only invalid if subpath export resolves to current file
          // Check if this file is referenced in the package.json exports entry for the import path
          const exports = packageMetadata.getNormalizedNpmModuleExportEntries();
          const exportEntry = exports.find(([name]) => importPath === name);
          if (exportEntry) {
            const resolvedExport = exportEntry[1].default;
            // Resolved path of file that is trying to be imported, without extensions
            const resolvedExportPath = packageMetadata.resolve(
              'src',
              removeExtension(resolvedExport),
            );
            if (removeExtension(context.filename) === resolvedExportPath) {
              reportSelfImport();
            }
          }
        }
      },
    };
  },

  meta: {
    docs: {
      category: 'Best Practices',
      description:
        'Disallow a package from importing from itself, except type-only imports',
      recommended: true,
    },
    fixable: 'code',
    hasSuggestions: true,
    messages: {
      moduleSelfImport: `Exported module {{ moduleName }} should not import from itself. Use a relative import instead.`,
      moduleSelfImportSuggestion: `Rename import of {{ moduleName }} to {{ suggestedModuleName }}`,
      packagesImport: `Invalid import from {{ moduleName }} outside of the tests, use a public or relative export.`,
      packagesImportSuggestion: `Rename import of {{ moduleName }} to {{ suggestedModuleName }}`,
    },
    schema: [],
  },
};

export default rule;
