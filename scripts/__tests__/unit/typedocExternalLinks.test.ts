/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Application} from 'typedoc';
import {expect, onTestFinished, test} from 'vitest';

import {
  externalSymbolLinkMappings,
  load,
} from '../../../packages/lexical-website/src/plugins/lexical-typedoc-plugin-external-links/index.mjs';

const websiteRequire = createRequire(
  path.resolve('packages/lexical-website/package.json'),
);

test.each(['flat', 'pnpm'])(
  'links external types and sources with a %s install',
  async layout => {
    const directory = realpathSync(
      mkdtempSync(path.join(tmpdir(), 'lexical-typedoc-')),
    );
    onTestFinished(() => rmSync(directory, {force: true, recursive: true}));
    const packageDirectory = path.join(
      directory,
      'node_modules',
      ...(layout === 'pnpm'
        ? ['.pnpm', '@fixture+types@1.2.3', 'node_modules']
        : []),
      '@fixture/types',
    );
    mkdirSync(packageDirectory, {recursive: true});
    if (layout === 'pnpm') {
      mkdirSync(path.join(directory, 'node_modules/@fixture'));
      symlinkSync(
        packageDirectory,
        path.join(directory, 'node_modules/@fixture/types'),
        'junction',
      );
    }
    writeFileSync(
      path.join(packageDirectory, 'package.json'),
      JSON.stringify({
        name: '@fixture/types',
        types: 'index.d.ts',
        version: '1.2.3',
      }),
    );
    writeFileSync(
      path.join(packageDirectory, 'index.d.ts'),
      [
        '// An external declaration after a comment: 🦊',
        'export interface Node { value: string; }',
        'export interface Documented { value: string; }',
        'export declare class Box {',
        '  constructor(value: string);',
        '  get(): string;',
        '}',
      ].join('\r\n'),
    );
    writeFileSync(
      path.join(packageDirectory, 'large.d.ts'),
      '// ' + 'x'.repeat(50000) + '\nexport interface Large { value: string; }',
    );
    writeFileSync(
      path.join(packageDirectory, 'many-lines.d.ts'),
      '\n'.repeat(2000) + 'export interface ManyLines { value: string; }',
    );
    writeFileSync(
      path.join(packageDirectory, 'mapped.js'),
      '\n'.repeat(20) +
        'export class Mapped {}\n\n\n\nexport class MappedBox {}\n',
    );
    writeFileSync(
      path.join(packageDirectory, 'mapped.d.ts'),
      [
        'export declare class Mapped {}',
        'export declare class MappedBox {}',
        '//# sourceMappingURL=mapped.d.ts.map',
      ].join('\n'),
    );
    writeFileSync(
      path.join(packageDirectory, 'mapped.d.ts.map'),
      JSON.stringify({
        file: 'mapped.d.ts',
        mappings: 'AAoBA;AAIA',
        names: [],
        sourceRoot: '',
        sources: ['mapped.js'],
        version: 3,
      }),
    );
    for (const name of ['private', 'no-manifest']) {
      const dependency = path.join(path.dirname(packageDirectory), name);
      mkdirSync(dependency, {recursive: true});
      if (layout === 'pnpm') {
        symlinkSync(
          dependency,
          path.join(directory, 'node_modules/@fixture', name),
          'junction',
        );
      }
      if (name === 'private') {
        writeFileSync(
          path.join(dependency, 'package.json'),
          JSON.stringify({
            name: '@fixture/private',
            private: true,
            version: '1.0.0',
          }),
        );
      }
      writeFileSync(
        path.join(dependency, 'index.d.ts'),
        'export interface Unpublished { value: string; }',
      );
    }
    writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({name: 'fixture', private: true}),
    );
    writeFileSync(
      path.join(directory, 'index.ts'),
      [
        "import type {Node, Documented} from '@fixture/types';",
        "export {Box} from '@fixture/types';",
        '/** Links to {@link Node}, {@link Documented}, and {@link Local}. */',
        'export interface Local {',
        '  node: Node;',
        '  documented: Documented;',
        '  element: HTMLElement;',
        '  optional: Partial<Local>;',
        '}',
        "export {Large} from '@fixture/types/large';",
        "export {ManyLines} from '@fixture/types/many-lines';",
        "export {Unpublished as Private} from '@fixture/private';",
        "export {Unpublished as NoManifest} from '@fixture/no-manifest';",
        "import type {Mapped} from '@fixture/types/mapped';",
        "export {MappedBox} from '@fixture/types/mapped';",
        '/** Links to {@link Mapped}. */',
        'export interface WithMapped { value: Mapped; }',
      ].join('\n'),
    );
    const tsconfig = path.join(directory, 'tsconfig.json');
    writeFileSync(
      tsconfig,
      JSON.stringify({
        compilerOptions: {
          lib: ['esnext', 'dom'],
          skipLibCheck: true,
          strict: true,
          types: [],
        },
        files: ['index.ts'],
      }),
    );
    const app = await Application.bootstrapWithPlugins({
      disableGit: true,
      entryPoints: [path.join(directory, 'index.ts')],
      externalSymbolLinkMappings: {
        ...externalSymbolLinkMappings,
        '@fixture/types': {Documented: 'https://example.com/documented'},
      },
      logLevel: 'Error',
      plugin: [websiteRequire.resolve('typedoc-plugin-markdown'), load],
      readme: 'none',
      router: 'module',
      sourceLinkTemplate:
        'https://github.com/meta/lexical/blob/main/{path}#L{line}',
      tsconfig,
    });
    const project = await app.convert();
    expect(project).toBeDefined();
    const output = path.join(directory, 'docs');
    app.options.setValue('out', output);
    await app.generateOutputs(project!);
    const markdown = readFileSync(path.join(output, 'README.md'), 'utf8');
    expect(markdown).toContain(
      'https://developer.mozilla.org/docs/Web/API/HTMLElement',
    );
    expect(markdown).toContain(
      'https://www.typescriptlang.org/docs/handbook/utility-types.html#partialtype',
    );
    // An external Node must not be confused with the DOM Node of the same name.
    expect(markdown).toContain(
      'https://app.unpkg.com/@fixture/types@1.2.3/files/index.d.ts#L2',
    );
    expect(markdown).toContain('https://example.com/documented');
    expect(markdown).not.toContain('node_modules');
    for (const name of ['private', 'no-manifest']) {
      expect(markdown).toContain(`@fixture/${name}/index.d.ts:1`);
      expect(markdown).not.toContain(`unpkg.com/@fixture/${name}`);
      expect(markdown).not.toContain(`[\u0040fixture/${name}/index.d.ts:1](`);
    }
    // UNPKG omits its interactive line viewer above either size limit.
    for (const file of ['large.d.ts', 'many-lines.d.ts']) {
      expect(markdown).toContain(
        `(https://app.unpkg.com/@fixture/types@1.2.3/files/${file})`,
      );
      expect(markdown).not.toContain(`${file}#L`);
    }
    expect(markdown).toContain(
      '[index.ts:4](https://github.com/meta/lexical/blob/main/index.ts#L4)',
    );
    expect(markdown).toContain(
      '[@fixture/types/index.d.ts:4](https://app.unpkg.com/@fixture/types@1.2.3/files/index.d.ts#L4)',
    );
    expect(markdown).toContain(
      '[@fixture/types/index.d.ts:6](https://app.unpkg.com/@fixture/types@1.2.3/files/index.d.ts#L6)',
    );
    expect(markdown).toContain(
      'Links to [Node](https://app.unpkg.com/@fixture/types@1.2.3/files/index.d.ts#L2), [Documented](https://example.com/documented), and [Local](#local).',
    );
    // TypeDoc maps the symbol's file to mapped.js but retains its .d.ts offset.
    expect(markdown).toContain(
      'Links to [Mapped](https://app.unpkg.com/@fixture/types@1.2.3/files/mapped.js).',
    );
    expect(markdown).not.toContain('mapped.js#');
    // SourcePlugin keeps both the original declaration file and its line.
    expect(markdown).toContain(
      '[@fixture/types/mapped.d.ts:2](https://app.unpkg.com/@fixture/types@1.2.3/files/mapped.d.ts#L2)',
    );
  },
  20000,
);
