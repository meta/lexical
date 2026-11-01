/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {transformAsync as babelTransform} from '@babel/core';
import commonjs from '@rollup/plugin-commonjs';
import {transformSync} from 'esbuild';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {runInNewContext} from 'node:vm';
import {type Plugin, rollup, watch} from 'rollup';
import {createServer} from 'vite';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {subpathImports} from '../../SubpathImports';

let dir: string;
let packageJson: string;

function write(file: string, code: string) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), {recursive: true});
  fs.writeFileSync(path.join(dir, file), code);
}

function plugin(strict = true) {
  return subpathImports({packages: [packageJson], strict});
}

function transform(code: string, filename = 'consumer.ts', strict = true) {
  return plugin(strict).transform(code, path.join(dir, filename))?.code ?? code;
}

beforeEach(() => {
  dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lexical-subpath-imports-')),
  );
  packageJson = path.join(dir, 'package.json');
  write(
    'package.json',
    JSON.stringify({
      exports: {
        '.': {default: './src/index.ts', source: './src/index.ts'},
        './big': {default: './src/big.ts', source: './src/big.ts'},
        './small': {default: './src/small.ts', source: './src/small.ts'},
      },
      name: '@lexical/example',
      sideEffects: false,
    }),
  );
  write(
    'src/index.ts',
    `
    export {value as publicValue, default as defaultValue, type Thing} from './small';
    export {unused} from './big';
  `,
  );
  write(
    'src/small.ts',
    `export const value = {}; export default value; export type Thing = {x: number};`,
  );
  write('src/big.ts', `export const unused = 'unwanted extension';`);
});

afterEach(() => fs.rmSync(dir, {force: true, recursive: true}));

describe('subpathImports', () => {
  it.each([
    `import typeof * as Extension from '@lexical/example'; export type T = Extension;`,
    `import typeof {publicValue as Factory} from '@lexical/example'; export type T = Factory;`,
    `import typeof Factory from '@lexical/example'; export type T = Factory;`,
    `import {typeof publicValue as Factory} from '@lexical/example'; export type T = Factory;`,
    `import {typeof default as Factory} from '@lexical/example'; export type T = Factory;`,
  ])('preserves erased Flow imports: %s', async code => {
    const instance = subpathImports({
      packages: [packageJson],
      parserPlugins: ['flow'],
      strict: true,
    });
    const rewritten =
      instance.transform(code, path.join(dir, 'consumer.js'))?.code ?? code;
    const strip = (source: string) =>
      babelTransform(source, {
        babelrc: false,
        configFile: false,
        filename: path.join(dir, 'consumer.js'),
        presets: ['@babel/preset-flow'],
      });
    expect((await strip(code))?.code).toBe('');
    expect((await strip(rewritten))?.code).toBe('');
  });

  it('preserves typeof specifiers while narrowing runtime imports', async () => {
    const instance = subpathImports({
      packages: [packageJson],
      parserPlugins: ['flow'],
      strict: true,
    });
    const code = `import {typeof publicValue as Factory, typeof default as DefaultFactory, unused} from '@lexical/example';
      export type T = Factory; export type D = DefaultFactory; export {unused};`;
    const rewritten = instance.transform(
      code,
      path.join(dir, 'consumer.js'),
    )?.code;
    expect(rewritten).toContain('typeof publicValue as Factory');
    expect(rewritten).toContain('typeof default as DefaultFactory');
    const stripped = await babelTransform(rewritten!, {
      babelrc: false,
      configFile: false,
      presets: ['@babel/preset-flow'],
    });
    expect(stripped?.code).toContain('from "@lexical/example/big"');
    expect(stripped?.code).not.toContain('@lexical/example/small');
    expect(stripped?.code).not.toContain('from "@lexical/example"');
  });

  it.each([['flow'], [['flow', {all: true}]], ['flow', 'flowComments']])(
    'parses Flow consumers of TypeScript packages with %j',
    (...parserPlugins) => {
      const instance = subpathImports({
        packages: [packageJson],
        parserPlugins,
        strict: true,
      });
      const code = `import {publicValue} from '@lexical/example';
      export const result: mixed = publicValue;`;
      const output = instance.transform(
        code,
        path.join(dir, 'consumer.js'),
      )?.code;
      expect(output).toContain(
        'import {value as publicValue} from "@lexical/example/small";',
      );
      expect(output).toContain('export const result: mixed = publicValue;');
      const typescript = `import {publicValue} from '@lexical/example';
      const identity = <T>(value: T) => value;`;
      expect(
        instance.transform(typescript, path.join(dir, 'consumer.ts'))?.code,
      ).toContain('const identity = <T>(value: T) => value;');
    },
  );

  it('accepts extra parser plugins without replacing the filename defaults', () => {
    const code = `import {publicValue} from '@lexical/example';
      const identity = <T>(value: T) => value;
      export const result = do { identity(publicValue); };`;
    expect(() => transform(code)).toThrow('doExpressions');
    const parserPlugins = Object.freeze(['doExpressions']);
    const instance = subpathImports({
      packages: [packageJson],
      parserPlugins,
      strict: true,
    });
    const output = instance.transform(
      code,
      path.join(dir, 'consumer.ts'),
    )?.code;
    expect(output).toContain(
      'import {value as publicValue} from "@lexical/example/small";',
    );
    expect(output).toContain('const identity = <T>(value: T) => value;');
    expect(output).toContain('do { identity(publicValue); }');
    expect(parserPlugins).toEqual(['doExpressions']);
  });

  it('preserves parser plugin options through the legacy decorator fallback', () => {
    const code = `import {publicValue} from '@lexical/example';
      export class Example { constructor(@decorate value: unknown) {} }
      export const result = publicValue |> consume;`;
    const instance = subpathImports({
      packages: [packageJson],
      parserPlugins: [['pipelineOperator', {proposal: 'fsharp'}]],
      strict: true,
    });
    const output = instance.transform(
      code,
      path.join(dir, 'consumer.ts'),
    )?.code;
    expect(output).toContain(
      'import {value as publicValue} from "@lexical/example/small";',
    );
    expect(output).toContain('publicValue |> consume');
    expect(output).toContain('@decorate value: unknown');
  });

  it('uses extra parser plugins when reading star-exported sources', () => {
    const barrel = `export * from './small';`;
    write('src/index.ts', barrel);
    write('src/small.ts', `export const value = do { 42; };`);
    const instance = subpathImports({
      packages: [packageJson],
      parserPlugins: ['doExpressions'],
      strict: true,
    });
    instance.buildStart.call({addWatchFile() {}});
    expect(
      instance.transform(barrel, path.join(dir, 'src/index.ts'))?.code,
    ).toBe('export {value} from "@lexical/example/small";');
  });

  it('uses extra parser plugins when inspecting an executable root entry', () => {
    write('src/index.ts', `const value = do { 42; }; export {value};`);
    const instance = subpathImports({
      packages: [packageJson],
      parserPlugins: ['doExpressions'],
      strict: true,
    });
    expect(
      instance.transform(
        `import {value} from '@lexical/example';`,
        path.join(dir, 'consumer.ts'),
      ),
    ).toBeNull();
  });

  it('derives renamed and default bindings from the installed barrel', () => {
    const output = transform(
      `import {publicValue as local, defaultValue} from '@lexical/example'; console.log(local, defaultValue);`,
    );
    expect(output).toContain(
      'import {value as local} from "@lexical/example/small";',
    );
    expect(output).toContain(
      'import {default as defaultValue} from "@lexical/example/small";',
    );
    expect(output).toContain('console.log(local, defaultValue)');
  });

  it('preserves re-export aliases and type-only bindings', () => {
    expect(
      transform(`export {publicValue as renamed} from '@lexical/example';`),
    ).toBe('export {value as renamed} from "@lexical/example/small";');
    const code = `import type {Thing} from '@lexical/example';`;
    expect(transform(code)).toBe(code);
    const mixed = transform(
      `import {type Thing, publicValue} from '@lexical/example';`,
    );
    expect(mixed).toContain('import {type Thing} from "@lexical/example";');
    expect(transformSync(mixed, {loader: 'ts'}).code).not.toContain(
      '@lexical/example"',
    );
  });

  it('externalizes public sibling entries, including relative barrel paths', () => {
    expect(transform(`export {value} from './small';`, 'src/index.ts')).toBe(
      'export {value} from "@lexical/example/small";',
    );
    expect(
      transform(`import {publicValue} from './index.js';`, 'src/consumer.ts'),
    ).toBe('import {value as publicValue} from "@lexical/example/small";');
    const privateImport = `import {helper} from './private';`;
    expect(transform(privateImport, 'src/small.ts')).toBe(privateImport);
  });

  it('follows compatibility exports to a different package', () => {
    write('src/index.ts', `export {defineExtension as define} from 'lexical';`);
    expect(transform(`import {define} from '@lexical/example';`)).toBe(
      'import {defineExtension as define} from "lexical";',
    );
  });

  it('supports transparent star barrels without accidentally exporting default', () => {
    write('src/index.ts', `export * from './small';`);
    expect(transform(`import {value} from '@lexical/example';`)).toBe(
      'import {value} from "@lexical/example/small";',
    );
    expect(() => transform(`import value from '@lexical/example';`)).toThrow(
      'use named subpath imports',
    );
  });

  it('rewrites dynamic sibling imports inside exported declarations', () => {
    expect(
      transform(`export const rel = import('./small');`, 'src/big.ts'),
    ).toBe('export const rel = import("@lexical/example/small");');
    const type = `export type Thing = import('@lexical/example').Thing;`;
    expect(transform(type)).toBe(type);
  });

  it('rewrites static templates and TypeScript import assignments to siblings', () => {
    for (const code of [
      'export const rel = import(`./small`);',
      'export const rel = require(`./small`);',
      "import rel = require('./small');",
    ]) {
      expect(transform(code, 'src/big.ts')).toContain(
        '("@lexical/example/small")',
      );
    }
    const type = "import type Ext = require('@lexical/example');";
    expect(transform(type)).toBe(type);
    const computed = 'export const rel = import(`@lexical/${name}`);';
    expect(transform(computed)).toBe(computed);
  });

  it.each(['.cjs', '.js'])(
    'preserves CommonJS dependency parsing for %s',
    async extension => {
      write(
        `node_modules/dependency/index${extension}`,
        'if (globalThis.skip) return; module.exports = 42;',
      );
      write(
        'consumer.js',
        `export {default as value} from './node_modules/dependency/index${extension}';`,
      );
      const build = await rollup({
        input: path.join(dir, 'consumer.js'),
        plugins: [plugin(), commonjs({extensions: ['.js', '.cjs']})],
      });
      try {
        const {output} = await build.generate({format: 'cjs'});
        const exports: {value?: number} = {};
        runInNewContext(output[0].code, {exports});
        expect(exports.value).toBe(42);
      } finally {
        await build.close();
      }
    },
  );

  it('still checks barrel loads in CommonJS files with top-level returns', () => {
    expect(() =>
      transform(
        "if (globalThis.skip) return; module.exports = require('@lexical/example');",
        'consumer.cjs',
      ),
    ).toThrow('use named subpath imports');
  });

  it.each(['.js', '.mjs', '.cjs', '.jsx'])(
    'accepts JSX in %s before the downstream JSX transform',
    async extension => {
      const entry = path.join(dir, `Component${extension}`);
      for (const withBarrelImport of [false, true]) {
        write(
          `Component${extension}`,
          `${withBarrelImport ? "import {publicValue} from '@lexical/example'; export {publicValue};" : ''}
          const h = tag => tag;
          export const value = <span />;`,
        );
        const build = await rollup({
          input: entry,
          plugins: [
            plugin(),
            {
              name: 'fixture-jsx',
              transform(source, id) {
                return id === entry
                  ? {
                      code: transformSync(source, {
                        jsxFactory: 'h',
                        loader: 'jsx',
                      }).code,
                      map: null,
                    }
                  : null;
              },
            },
            fixtureCompiler(),
          ],
          treeshake: false,
        });
        try {
          const {output} = await build.generate({format: 'cjs'});
          const exports: {value?: string; publicValue?: unknown} = {};
          runInNewContext(output[0].code, {exports});
          expect(exports.value).toBe('span');
          if (withBarrelImport) {
            expect(exports.publicValue).toEqual({});
            expect(Object.keys(output[0].modules)).not.toContain(
              path.join(dir, 'src/index.ts'),
            );
            expect(output[0].code).not.toContain('unwanted extension');
          }
        } finally {
          await build.close();
        }
      }
    },
  );

  it.each(['.ts', '.mts', '.cts'])(
    'preserves non-JSX TypeScript parsing in %s',
    extension => {
      const declarations = `const identity = <T>(value: T) => value; export const value = identity(<number>42);`;
      const output = transform(
        `import {publicValue} from '@lexical/example'; ${declarations}`,
        `consumer${extension}`,
      );
      expect(output).toContain(
        'import {value as publicValue} from "@lexical/example/small";',
      );
      expect(output).toContain(declarations);
    },
  );

  it('narrows default imports when the barrel explicitly exports a default', () => {
    write('src/index.ts', `export {default} from './small';`);
    expect(transform(`import value from '@lexical/example';`)).toBe(
      'import {default as value} from "@lexical/example/small";',
    );
  });

  it.each([
    `export enum Mode {A, B}`,
    `export const enum Mode {A, B}`,
    `export namespace Mode { export const A = 0; export const B = 1; }`,
  ])('preserves runtime TypeScript star exports: %s', async declaration => {
    write('src/index.ts', `export * from './small';`);
    write('src/small.ts', `${declaration}; export const label = 'mode';`);
    const result = await bundle(
      `import * as all from '@lexical/example'; export {all};`,
      false,
    );
    const exports: {all?: {Mode: {A: number; B: number}; label: string}} = {};
    runInNewContext(result.code, {exports});
    expect(Object.keys(exports.all || {}).sort()).toEqual(['Mode', 'label']);
    expect(exports.all?.Mode.A).toBe(0);
    expect(exports.all?.Mode.B).toBe(1);
  });

  it('excludes ambient TypeScript declarations when expanding stars', async () => {
    write('src/index.ts', `export * from './small';`);
    write(
      'src/small.ts',
      `
      export declare class AmbientClass {}
      export declare const ambientValue: number;
      export declare enum AmbientEnum {A}
      export declare namespace AmbientNamespace { const x: number; }
      export namespace Types { export type A = string; }
      export namespace Empty {}
      export const label = 'mode';
    `,
    );
    const result = await bundle(
      `import * as all from '@lexical/example'; export {all};`,
      false,
    );
    const exports: {all?: Record<string, unknown>} = {};
    runInNewContext(result.code, {exports});
    expect(Object.keys(exports.all || {})).toEqual(['label']);
  });

  it('resolves local bindings before expanding implicitly exported types', async () => {
    write('src/index.ts', `export * from './small';`);
    write(
      'src/small.ts',
      `
      type Thing = {};
      interface Shape {}
      declare class Ambient {}
      namespace Types { export type T = string; }
      import type {Thing as Imported} from './big';
      interface Box { extra?: unknown; }
      class Box {}
      const value = 42;
      if (true) { var hoisted = 7; }
      export {Thing, Shape, Ambient, Types, Imported, Box, hoisted, value as label};
      `,
    );
    const result = await bundle(
      `import * as all from '@lexical/example'; export {all};`,
      false,
    );
    const exports: {all?: {hoisted: number; label: number}} = {};
    runInNewContext(result.code, {exports});
    expect(Object.keys(exports.all || {}).sort()).toEqual([
      'Box',
      'hoisted',
      'label',
    ]);
    expect(exports.all?.hoisted).toBe(7);
    expect(exports.all?.label).toBe(42);
  });

  it.each([
    [
      `export {"x-y" as xy} from './small';`,
      `export {xy} from '@lexical/example';`,
      'xy',
    ],
    [
      `export {"x-y"} from './small';`,
      `export {"x-y" as xy} from '@lexical/example';`,
      'xy',
    ],
    [`export * from './small';`, `export * from '@lexical/example';`, 'x-y'],
  ])('preserves quoted export names: %s', async (barrel, consumer, name) => {
    write('src/index.ts', barrel);
    write('src/small.ts', `const value = 42; export {value as "x-y"};`);
    const result = await bundle(consumer, false);
    const exports: Record<string, unknown> = {};
    runInNewContext(result.code, {exports});
    expect(exports).toEqual({[name]: 42});
  });

  it.each([
    `@decorate export class Example {}`,
    `export @decorate class Example {}`,
    `export class Example { @decorate accessor value = 1; }`,
    `export class Example { constructor(@decorate value: unknown) {} }`,
  ])('parses decorated TypeScript before transpilation: %s', declaration => {
    const code = `import {publicValue} from '@lexical/example'; ${declaration}`;
    expect(transform(code)).toContain(
      'import {value as publicValue} from "@lexical/example/small";',
    );
    expect(transform(declaration)).toBe(declaration);
  });

  it('does not bypass executable root entry points', () => {
    write(
      'src/index.ts',
      `globalThis.initialized = true; export {value} from './small';`,
    );
    const code = `import {value} from '@lexical/example';`;
    expect(transform(code)).toBe(code);
  });

  it('does not bypass packages that may initialize unused modules', () => {
    const metadata = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
    delete metadata.sideEffects;
    write('package.json', JSON.stringify(metadata));
    const code = `import {publicValue} from '@lexical/example';`;
    expect(transform(code)).toBe(code);
  });

  it('resolves package names from the consumer root without evaluating them', () => {
    const consumer = path.join(dir, 'consumer');
    fs.mkdirSync(path.join(consumer, 'node_modules/@lexical'), {
      recursive: true,
    });
    fs.symlinkSync(
      dir,
      path.join(consumer, 'node_modules/@lexical/example'),
      'junction',
    );
    const instance = subpathImports({
      packages: ['@lexical/example'],
      root: consumer,
      strict: true,
    });
    expect(
      instance.transform(
        `import {publicValue} from '@lexical/example';`,
        path.join(consumer, 'index.ts'),
      )?.code,
    ).toContain('@lexical/example/small');
  });

  it.each([
    `import * as extension from '@lexical/example';`,
    `import '@lexical/example';`,
    `export * from '@lexical/example';`,
    `export * as extension from '@lexical/example';`,
    `const extension = import('@lexical/example');`,
    `const extension = require('@lexical/example');`,
    `export const extension = require('@lexical/example');`,
    `export const extension = import('@lexical/example');`,
    `export function extension() { return require('@lexical/example'); }`,
    `export class Extension { load() { return import('@lexical/example'); } }`,
    `import extension from '@lexical/example';`,
    `import {default as extension} from '@lexical/example';`,
    `import extension = require('@lexical/example');`,
    `export import extension = require('@lexical/example');`,
    'export const extension = import(`@lexical/example`);',
    'export const extension = require(`@lexical/example`);',
    'export const extension = import(`@lexical/\\x65xample`);',
  ])('rejects unsplittable usage in strict mode: %s', code => {
    expect(() => transform(code)).toThrow('use named subpath imports');
    expect(transform(code, 'consumer.ts', false)).toBe(code);
  });

  it('fails on missing exports instead of silently retaining the barrel', () => {
    expect(() => transform(`import {typo} from '@lexical/example';`)).toThrow(
      'unknown barrel export @lexical/example:typo',
    );
  });

  it('refreshes the mapping on rebuild and watches its source files', () => {
    const instance = plugin();
    const watched: string[] = [];
    const context = {addWatchFile: (file: string) => watched.push(file)};
    instance.buildStart.call(context);
    expect(watched).toContain(packageJson);
    expect(watched).toContain(path.join(dir, 'src/index.ts'));
    write('src/index.ts', `export {unused as publicValue} from './big';`);
    instance.buildStart.call(context);
    expect(
      instance.transform(
        `import {publicValue} from '@lexical/example';`,
        path.join(dir, 'consumer.ts'),
      )?.code,
    ).toContain('unused as publicValue');
  });

  it('invalidates cached consumer transforms in a real watch rebuild', async () => {
    write('consumer.ts', `export {publicValue} from '@lexical/example';`);
    const watcher = watch({
      input: path.join(dir, 'consumer.ts'),
      output: {file: path.join(dir, 'output.js'), format: 'cjs'},
      plugins: [plugin(), fixtureCompiler()],
      watch: {chokidar: {interval: 20, usePolling: true}, skipWrite: true},
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let builds = 0;
        watcher.on('event', async event => {
          if (event.code === 'ERROR') reject(event.error);
          if (event.code !== 'BUNDLE_END') return;
          try {
            const {output} = await event.result.generate({format: 'cjs'});
            await event.result.close();
            const exports: {publicValue?: unknown} = {};
            runInNewContext(output[0].code, {exports});
            if (++builds === 1) {
              expect(exports.publicValue).toEqual({});
              // Let the file watcher finish registering before changing the barrel.
              await new Promise(done => setTimeout(done, 100));
              write(
                'src/index.ts',
                `export {unused as publicValue} from './big';`,
              );
            } else {
              expect(exports.publicValue).toBe('unwanted extension');
              resolve();
            }
          } catch (error) {
            reject(error);
          }
        });
      });
    } finally {
      await watcher.close();
    }
  }, 20_000);

  it('refreshes mappings and invalidates cached consumers in a Vite dev server', async () => {
    write('consumer.ts', `export {publicValue} from '@lexical/example';`);
    let updated: ((file: string, ids: (string | null)[]) => void) | undefined;
    const server = await createServer({
      configFile: false,
      logLevel: 'silent',
      optimizeDeps: {noDiscovery: true},
      plugins: [
        plugin(),
        fixtureCompiler(),
        {
          handleHotUpdate({file, modules}) {
            updated?.(
              file,
              modules.map(module => module.id),
            );
          },
          name: 'observe-hot-update',
        },
      ],
      root: dir,
      server: {middlewareMode: true, watch: {interval: 20, usePolling: true}},
    });
    const update = async (file: string, code: string, target: string) => {
      await expect
        .poll(
          () => server.watcher.getWatched()[path.dirname(path.join(dir, file))],
        )
        .toContain(path.basename(file));
      const change = new Promise<(string | null)[]>(resolve => {
        updated = (changed, ids) => {
          if (changed === path.join(dir, file)) resolve(ids);
        };
      });
      write(file, code);
      expect(await change).toContain(path.join(dir, 'consumer.ts'));
      expect((await server.transformRequest('/consumer.ts'))?.code).toContain(
        target,
      );
    };
    try {
      expect((await server.transformRequest('/consumer.ts'))?.code).toContain(
        '/src/small.ts',
      );
      await update(
        'src/index.ts',
        `export {unused as publicValue} from './big';`,
        '/src/big.ts',
      );
      write('src/other.ts', `export {value as publicValue} from './small';`);
      const metadata = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
      metadata.exports['.'].source = './src/other.ts';
      await update('package.json', JSON.stringify(metadata), '/src/small.ts');
      await update(
        'src/other.ts',
        `export {unused as publicValue} from './big';`,
        '/src/big.ts',
      );
    } finally {
      await server.close();
    }
  }, 20_000);

  it('produces source maps and handles TSX and query-suffixed module IDs', () => {
    const result = plugin().transform(
      `import {publicValue} from '@lexical/example'; export const x = <div>{publicValue}</div>;`,
      path.join(dir, 'consumer.tsx?direct'),
    );
    expect(result?.map.sourcesContent?.[0]).toContain('<div>');
    expect(result?.code).toContain('@lexical/example/small');
    expect(plugin().transform('not JavaScript', 'styles.css')).toBeNull();
  });

  function fixtureCompiler(): Plugin {
    return {
      name: 'fixture-resolution',
      resolveId(source) {
        if (source === '@lexical/example')
          return path.join(dir, 'src/index.ts');
        if (source.startsWith('@lexical/example/'))
          return path.join(dir, `src/${source.split('/').pop()}.ts`);
        return null;
      },
      transform(source, id) {
        return {
          code: transformSync(source, {loader: 'ts', sourcefile: id}).code,
          map: null,
        };
      },
    };
  }

  async function bundle(code: string, strict: boolean) {
    write('consumer.ts', code);
    const build = await rollup({
      input: path.join(dir, 'consumer.ts'),
      plugins: [plugin(strict), fixtureCompiler()],
      treeshake: false,
    });
    try {
      const {output} = await build.generate({format: 'cjs'});
      return {code: output[0].code, modules: Object.keys(output[0].modules)};
    } finally {
      await build.close();
    }
  }

  it('excludes unrelated extensions with tree-shaking disabled', async () => {
    const result = await bundle(
      `export {publicValue} from '@lexical/example';`,
      true,
    );
    expect(result.modules).toContain(path.join(dir, 'src/small.ts'));
    expect(result.modules).not.toContain(path.join(dir, 'src/index.ts'));
    expect(result.modules).not.toContain(path.join(dir, 'src/big.ts'));
    expect(result.code).not.toContain('unwanted extension');
  });

  it('preserves barrel consumers and shared object identity without tree-shaking', async () => {
    const result = await bundle(
      `import * as all from '@lexical/example'; import {value} from '@lexical/example/small'; export const same = all.publicValue === value; export {all};`,
      false,
    );
    const exports: {same?: boolean; all?: Record<string, unknown>} = {};
    // Execute the generated fixture, which has no external dependencies.
    runInNewContext(result.code, {exports});
    expect(exports.same).toBe(true);
    expect(Object.keys(exports.all || {}).sort()).toEqual([
      'defaultValue',
      'publicValue',
      'unused',
    ]);
    expect(
      result.modules.filter(file => file.endsWith('/small.ts')),
    ).toHaveLength(1);
  });
});
