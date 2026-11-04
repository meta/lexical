/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {NpmModuleExports} from '../../shared/PackageMetadata.mjs';

import * as fs from 'fs-extra';
import * as glob from 'glob';
import * as path from 'node:path';
import {describe, expect, it, test} from 'vitest';

import {packagesManager} from '../../shared/packagesManager';
import {SUB_ENTRIES, subEntriesOf} from '../../shared/subEntries.mjs';
import {
  MIN_TYPESCRIPT_VERSION,
  tooOldStubPath,
  tooOldTypesVersions,
  TYPESCRIPT_TOO_OLD_CONDITION,
} from '../../shared/typescriptTooOld';
import npmToWwwName from '../../www/npmToWwwName';

const monorepoPackageJson = (
  await import('../../shared/readMonorepoPackageJson')
).default();

const publicNpmNames = new Set(
  packagesManager.getPublicPackages().map(pkg => pkg.getNpmName()),
);

describe('standalone projects are their own pnpm workspace root', () => {
  // Examples and integration fixtures live inside the monorepo tree but are
  // not workspace members. Each needs its own pnpm-workspace.yaml: it is what
  // stops a `pnpm install` there from climbing into the monorepo and picking
  // up its settings, and it is the only place pnpm reads that project's
  // `overrides` and build-script decisions from (`package.json#pnpm` is
  // ignored). Without one, `pnpm install` in the project fails with
  // ERR_PNPM_IGNORED_BUILDS as soon as a dependency has a build script.
  for (const packageJsonPath of [
    'examples',
    'scripts/__tests__/integration/fixtures',
  ].flatMap(dir =>
    glob.sync(`${dir}/*/package.json`, {windowsPathsNoEscape: true}),
  )) {
    const projectDir = path.dirname(packageJsonPath);
    it(projectDir, () => {
      expect(
        fs.existsSync(path.resolve(projectDir, 'pnpm-workspace.yaml')),
      ).toBe(true);
    });
  }
});

describe('sub-entry opt-in list (shared/subEntries)', () => {
  it('names public packages and entries that exist', () => {
    const publics = new Map(
      packagesManager.getPublicPackages().map(pkg => [pkg.getNpmName(), pkg]),
    );
    for (const [name, entries] of Object.entries(SUB_ENTRIES)) {
      const pkg = publics.get(name);
      expect(pkg).toBeDefined();
      for (const entry of entries) {
        expect(fs.existsSync(pkg!.resolve('src', `${entry}.ts`))).toBe(true);
        expect(fs.existsSync(pkg!.resolve('src', entry))).toBe(true);
      }
    }
  });
});

describe('public package.json audits (`pnpm run update-packages` to fix most issues)', () => {
  packagesManager.getPublicPackages().forEach(pkg => {
    const npmName = pkg.getNpmName();
    const packageJson = pkg.packageJson;
    describe(npmName, () => {
      const sourceFiles = fs
        .readdirSync(pkg.resolve('src'))
        .filter(str => /\.tsx?/.test(str))
        .map(str => str.replace(/\.tsx?$/, ''))
        .sort();
      const exportedModules = pkg.getExportedNpmModuleNames().sort();
      const {dependencies = {}, peerDependencies = {}} = packageJson;
      if (packageJson.main) {
        it('should only export the main module with main set', () => {
          expect(exportedModules).toEqual([npmName]);
        });
      }
      it('has *.flow types', () => {
        expect(
          glob.sync(pkg.resolve('flow', '*.flow'), {
            windowsPathsNoEscape: true,
          }),
        ).not.toEqual([]);
      });
      it('uses the expected directory/npm naming convention', () => {
        expect(npmName.replace(/^@/, '').replace('/', '-')).toBe(
          pkg.getDirectoryName(),
        );
      });
      it('matches monorepo version', () => {
        expect(packageJson.version).toBe(monorepoPackageJson.version);
      });
      it('must not have a direct dependency on react or react-dom', () => {
        expect(dependencies).not.toContain('react');
        expect(dependencies).not.toContain('react-dom');
      });
      it('must not have monorepo peerDependencies', () => {
        expect(
          Object.keys(peerDependencies).filter(dep => publicNpmNames.has(dep)),
        ).toEqual([]);
      });
      it('monorepo dependencies must use workspace:* as the version', () => {
        Object.entries(dependencies).forEach(([dep, version]) => {
          if (publicNpmNames.has(dep)) {
            expect([dep, version]).toEqual([dep, 'workspace:*']);
          }
        });
      });
      it('exports sub-entries only of the entries that opt in (shared/subEntries), each source file of those', () => {
        // `<npm name>/<entry>/<name>`: an opted-in entry's src/<entry>/*.ts.
        const subExports = exportedModules
          .map(m => m.slice(npmName.length + 1))
          .filter(m => m.includes('/'));
        const expected = subEntriesOf(npmName).flatMap(entry => {
          const dir = pkg.resolve('src', entry);
          return fs.existsSync(dir)
            ? fs
                .readdirSync(dir)
                .filter(f => /^[^.]+\.ts$/.test(f))
                .map(f => `${entry}/${f.replace(/\.ts$/, '')}`)
            : [];
        });
        expect(subExports.sort()).toEqual(expected.sort());
      });
      it('must export at least one module', () => {
        expect(exportedModules.length).toBeGreaterThanOrEqual(1);
      });
      test.each(exportedModules)(
        `should have a source file for exported module %s`,
        exportedModule => {
          // src/<name>.tsx?, or src/<entry>/<name>.tsx? for a sub-entry
          // (`<npm name>/<entry>/<name>`, see PackageMetadata and
          // updateVersion).
          const name = exportedModule.slice(npmName.length + 1) || 'index';
          expect(
            ['.ts', '.tsx']
              .map(ext => `src/${name}${ext}`)
              .filter(file => fs.existsSync(pkg.resolve(file))),
          ).not.toEqual([]);
        },
      );
      describe('TypeScript "too old" guard (clear error for stale TypeScript)', () => {
        const tombstone = tooOldStubPath('dist');
        it('points the legacy "types" field at the stub', () => {
          // Only consumers that cannot read "exports" resolve "types", so the
          // stub is what an old/classic-resolution TypeScript sees.
          expect(packageJson.types).toBe(tombstone);
        });
        it('redirects the root and every subpath via "typesVersions"', () => {
          expect(packageJson.typesVersions).toEqual(
            tooOldTypesVersions('dist'),
          );
        });
        const exportsEntries = Object.entries(
          packageJson.exports as Record<string, NpmModuleExports>,
        );
        test.each(exportsEntries)(
          'exports["%s"] redirects sub-minimum TypeScript before the "types" condition',
          (_subpath, entry) => {
            for (const group of [entry, entry.browser]) {
              if (!group) {
                continue;
              }
              const keys = Object.keys(group);
              expect(group[TYPESCRIPT_TOO_OLD_CONDITION]).toBe(tombstone);
              // The versioned condition must sit immediately before plain
              // `types` so it wins for the (old) versions it matches.
              expect(keys.indexOf(TYPESCRIPT_TOO_OLD_CONDITION)).toBe(
                keys.indexOf('types') - 1,
              );
            }
          },
        );
        it('declares an optional typescript peer dependency at the minimum version', () => {
          expect(packageJson.peerDependencies?.typescript).toBe(
            `>=${MIN_TYPESCRIPT_VERSION}`,
          );
          expect(packageJson.peerDependenciesMeta?.typescript).toEqual({
            optional: true,
          });
        });
      });
      describe('publishes ESM only (CommonJS is built for www alone)', () => {
        // Every file a consumer can resolve is the package's ESM build, a
        // .d.ts, or the TypeScript source: no `require` condition and no
        // CommonJS build. A CommonJS consumer gets the ESM through
        // require(esm), so the fork module those conditions resolve to must
        // not use top-level await (scripts/build.mjs keeps it that way).
        it('is an ES module package', () => {
          expect(packageJson.type).toBe('module');
        });
        const referenced: [string, string][] = [];
        for (const field of ['main', 'module'] as const) {
          if (typeof packageJson[field] === 'string') {
            referenced.push([field, packageJson[field]]);
          }
        }
        for (const [subpath, entry] of Object.entries(
          packageJson.exports as Record<string, NpmModuleExports>,
        )) {
          for (const [condition, target] of Object.entries(entry)) {
            if (typeof target === 'string') {
              referenced.push([`exports["${subpath}"].${condition}`, target]);
            } else {
              for (const [k, v] of Object.entries(target)) {
                referenced.push([`exports["${subpath}"].${condition}.${k}`, v]);
              }
            }
          }
        }
        test.each(referenced)('%s -> %s', (location, target) => {
          expect(location).not.toMatch(/\b(import|require|node)\b/);
          expect(target).toMatch(/\.(js|d\.ts|tsx?)$/);
        });
      });
      if (!sourceFiles.includes('index')) {
        it('must not export a top-level module without an index.tsx?', () => {
          expect(exportedModules).not.toContain(npmName);
        });
        test.each(sourceFiles)(
          `%s.tsx? must have an exported module`,
          sourceFile => {
            expect(exportedModules).toContain(`${npmName}/${sourceFile}`);
          },
        );
      }
    });
  });
});

describe('documentation audits (`pnpm run update-packages` to fix most issues)', () => {
  packagesManager.getPublicPackages().forEach(pkg => {
    const npmName = pkg.getNpmName();
    describe(npmName, () => {
      const root = pkg.resolve('..', '..');
      const docPath = pkg.resolve('README.md');
      describe(path.relative(root, docPath), () => {
        it('exists', () => expect(fs.existsSync(docPath)).toBe(true));
        if (path.basename(docPath) === 'README.md') {
          it('does not have the TODO description', () => {
            expect(fs.readFileSync(docPath, 'utf8')).not.toContain(
              'TODO: This package needs a description!',
            );
          });
        }
      });
    });
  });
});

describe('www public package audits (`pnpm run update-packages` to fix most issues)', () => {
  packagesManager.getPublicPackages().forEach(pkg => {
    const npmName = pkg.getNpmName();
    const wwwEntrypoint = `${npmToWwwName(npmName)}.js`;
    describe(npmName, () => {
      it('has *.flow types', () => {
        expect(
          glob.sync(pkg.resolve('flow', '*.flow'), {
            windowsPathsNoEscape: true,
          }),
        ).not.toEqual([]);
      });
      // Only worry about the entrypoint stub if it has a single module export
      if (pkg.getExportedNpmModuleNames().every(name => name === npmName)) {
        it(`has a packages/${pkg.getDirectoryName()}/${wwwEntrypoint}`, () => {
          expect(fs.existsSync(pkg.resolve(wwwEntrypoint))).toBe(true);
        });
      }
    });
  });
});
