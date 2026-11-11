/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @ts-check

import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {describe, expect, it} from 'vitest';

import {packagesManager} from '../../shared/packagesManager.mjs';

const require = createRequire(import.meta.url);

describe('published extension subpaths', () => {
  it.each(['ExtensionRep', 'deepThemeMergeInPlace', 'editorStateFamily'])(
    'keeps %s private',
    name => {
      for (const suffix of ['', '.js']) {
        expect(() =>
          require.resolve(`@lexical/extension/${name}${suffix}`),
        ).toThrow(/not defined by "exports"/);
      }
    },
  );

  it.each(
    ['development', 'production'].flatMap(condition => [
      {
        condition,
        contents: `
          import {buildEditorFromExtensions} from '@lexical/extension/LexicalBuilder';
          import {RichTextExtension} from '@lexical/rich-text';
          export const editor = buildEditorFromExtensions(RichTextExtension);
        `,
        name: 'a rich-text editor',
      },
      {
        condition,
        contents: `
          export {LexicalExtensionComposer} from '@lexical/react/LexicalExtensionComposer';
          export {RichTextExtension} from '@lexical/rich-text';
        `,
        name: 'the React composer with rich-text',
      },
    ]),
  )(
    '$name excludes the barrel without tree-shaking ($condition)',
    async ({condition, contents}) => {
      const entries = new Map(
        packagesManager
          .getPublicPackages()
          .flatMap(pkg =>
            pkg
              .getNormalizedNpmModuleExportEntries()
              .map(([name, exports]) => [
                name,
                pkg.resolve(
                  condition === 'production'
                    ? exports.production
                    : exports.development,
                ),
              ]),
          ),
      );
      const result = await build({
        bundle: true,
        conditions: [condition],
        define: {'process.env.NODE_ENV': JSON.stringify(condition)},
        format: 'esm',
        logLevel: 'silent',
        metafile: true,
        platform: 'browser',
        plugins: [
          {
            name: 'published-package-entries',
            setup(builder) {
              builder.onResolve(
                {filter: /^(lexical|@lexical\/)/},
                ({path: name}) => {
                  const file = entries.get(name);
                  return file ? {path: file} : null;
                },
              );
            },
          },
        ],
        stdin: {
          contents,
          resolveDir: process.cwd(),
        },
        treeShaking: false,
        tsconfigRaw: {},
        write: false,
      });
      const files = Object.keys(result.metafile.inputs);
      expect(
        files.some(file => /LexicalExtensionLexicalBuilder\./.test(file)),
      ).toBe(true);
      expect(
        files.filter(file =>
          /LexicalExtension(?:AutoFocusExtension|HMRExtension)?\.(?:dev|prod)\.js$/.test(
            file,
          ),
        ),
      ).toEqual([]);
      expect(
        files.filter(file =>
          /LexicalExtensionSignals\.(?:dev|prod)\.js$/.test(file),
        ),
      ).toHaveLength(1);
    },
  );

  it('keeps barrel exports identical to their owning subpath values', () => {
    const pkg = packagesManager.getPackageByNpmName('@lexical/extension');
    const barrel = require('@lexical/extension');
    const values = Object.assign({}, require('lexical'));
    for (const {name} of pkg.getExportedNpmModuleEntries()) {
      if (name !== '@lexical/extension') Object.assign(values, require(name));
    }
    for (const [name, value] of Object.entries(barrel)) {
      expect(value, name).toBe(values[name]);
    }
    expect(Object.keys(barrel)).toContain('HorizontalRuleNode');
    expect(Object.keys(barrel)).toContain('signal');
  });

  // A module shared by two entries of a package must be reached through one
  // of them; bundled into both, it defines its extensions twice, and an
  // editor that uses the two copies fails to build.
  it('defines each extension in only one published entry', () => {
    /** @type {Map<string, {extension: unknown, module: string}>} */
    const seen = new Map();
    /** @param {unknown} value @param {string} module */
    const visit = (value, module) => {
      const extension = Array.isArray(value) ? value[0] : value;
      if (
        !extension ||
        typeof extension !== 'object' ||
        typeof extension.name !== 'string' ||
        !(
          'dependencies' in extension ||
          'register' in extension ||
          'build' in extension ||
          'nodes' in extension ||
          'config' in extension
        )
      ) {
        return;
      }
      const previous = seen.get(extension.name);
      if (previous) {
        expect(
          previous.extension === extension,
          `${extension.name} from ${module} and ${previous.module}`,
        ).toBe(true);
        return;
      }
      seen.set(extension.name, {extension, module});
      for (const dependency of extension.dependencies || []) {
        visit(dependency, module);
      }
    };
    for (const pkg of packagesManager.getPublicPackages()) {
      for (const {name} of pkg.getExportedNpmModuleEntries()) {
        for (const value of Object.values(require(name))) {
          visit(value, name);
        }
      }
    }
    expect(seen.get('@lexical/html/DOMImport')).toBeDefined();
  });
});
