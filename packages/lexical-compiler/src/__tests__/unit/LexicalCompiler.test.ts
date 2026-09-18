/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Plugin} from 'vite';

import * as path from 'node:path';
import {describe, expect, it, vi} from 'vitest';

import {
  PURE_FACTORY_FUNCTIONS,
  pureAnnotations,
  type PureAnnotationsPlugin,
  transformPureAnnotations,
} from '../../index';

const PURE = '/* @__PURE__ */';

const IMPORT = `import {configExtension, createCommand, defineExtension, defineImportRule, safeCast} from 'lexical';`;

/** A module that imports the factories from `lexical`, as consumers do. */
function mod(...lines: string[]): string {
  return [IMPORT, ...lines].join('\n');
}

function transform(code: string, filename = 'test.ts'): string {
  const result = transformPureAnnotations(code, {filename});
  return result === null ? code : result.code;
}

describe('transformPureAnnotations', () => {
  it('exports the factories the annotations are needed for', () => {
    expect(PURE_FACTORY_FUNCTIONS).toContain('defineExtension');
    expect(PURE_FACTORY_FUNCTIONS).toContain('createCommand');
    expect(PURE_FACTORY_FUNCTIONS).toContain('safeCast');
  });

  it('annotates a module-scope call', () => {
    expect(
      transform(mod(`export const E = defineExtension({name: 'e'});`)),
    ).toBe(mod(`export const E = ${PURE}defineExtension({name: 'e'});`));
  });

  it('annotates a call whose initializer is on its own line', () => {
    expect(transform(mod(`export const C =`, `  createCommand('C');`))).toBe(
      mod(`export const C =`, `  ${PURE}createCommand('C');`),
    );
  });

  it('annotates argument-position calls that would pin the enclosing call', () => {
    expect(
      transform(
        mod(
          `export const E = defineExtension({config: safeCast({a: 1}), name: 'e'});`,
        ),
      ),
    ).toBe(
      mod(
        `export const E = ${PURE}defineExtension({config: ${PURE}safeCast({a: 1}), name: 'e'});`,
      ),
    );
  });

  it('annotates calls nested in an array', () => {
    expect(
      transform(mod(`const deps = [configExtension(Other, {x: 1})];`)),
    ).toBe(mod(`const deps = [${PURE}configExtension(Other, {x: 1})];`));
  });

  it('reports how many annotations it inserted', () => {
    const result = transformPureAnnotations(
      mod(`const a = createCommand('a');`, `const b = createCommand('b');`),
    );
    expect(result).not.toBeNull();
    expect(result!.count).toBe(2);
  });

  it('returns null when there is nothing to annotate', () => {
    expect(transformPureAnnotations(`export const x = 1;`)).toBeNull();
    expect(
      transformPureAnnotations(
        mod(`export const E = ${PURE}defineExtension({});`),
      ),
    ).toBeNull();
  });

  it('is idempotent, including for the terser # sigil', () => {
    expect(
      transformPureAnnotations(
        mod(
          `export const E = ${PURE}defineExtension({name: 'e'});`,
          `export const C = /* #__PURE__ */ createCommand('C');`,
        ),
      ),
    ).toBeNull();
  });

  it('annotates the call when the annotation precedes the statement instead', () => {
    // An annotation that does not directly precede a call expression has no
    // effect on any bundler, so the call still needs its own.
    expect(transform(mod(PURE, `export const C = createCommand('C');`))).toBe(
      mod(PURE, `export const C = ${PURE}createCommand('C');`),
    );
  });

  it('leaves deferred calls alone', () => {
    expect(
      transformPureAnnotations(
        mod(
          `export function make() { return createCommand('a'); }`,
          `export const lazy = () => defineImportRule({name: 'r'});`,
          `class A {`,
          `  field = createCommand('field');`,
          `  method() { return createCommand('method'); }`,
          `  static { createCommand('static'); }`,
          `}`,
          `const obj = {method() { return createCommand('obj'); }};`,
        ),
      ),
    ).toBeNull();
  });

  it('leaves calls to functions outside the list alone', () => {
    expect(
      transformPureAnnotations(
        `import {someOtherFactory} from 'lexical';\nconst x = someOtherFactory();`,
      ),
    ).toBeNull();
  });

  it('accepts a custom function list', () => {
    const result = transformPureAnnotations(
      [
        `import {createCommand, myFactory} from 'lexical';`,
        `const x = myFactory();`,
        `const y = createCommand('y');`,
      ].join('\n'),
      {functions: ['myFactory']},
    );
    expect(result!.code).toBe(
      [
        `import {createCommand, myFactory} from 'lexical';`,
        `const x = ${PURE}myFactory();`,
        `const y = createCommand('y');`,
      ].join('\n'),
    );
  });

  it('parses TypeScript', () => {
    expect(
      transform(
        mod(
          `export const E = defineExtension({config: safeCast<Config>({}), name: 'e'});`,
          `export const identity = <T,>(value: T): T => value;`,
        ),
      ),
    ).toContain(`${PURE}safeCast<Config>({})`);
  });

  it('parses TSX', () => {
    expect(
      transform(
        mod(
          `const el = <div className="x">{'hi'}</div>;`,
          `export const E = defineExtension({name: 'e'});`,
        ),
        'test.tsx',
      ),
    ).toContain(`${PURE}defineExtension`);
  });

  it('parses JSX in a .js file', () => {
    expect(
      transform(
        mod(`const el = <div />;`, `export const C = createCommand('C');`),
        'test.js',
      ),
    ).toContain(`${PURE}createCommand`);
  });

  it('generates a source map by default and skips it on request', () => {
    const code = mod(`export const C = createCommand('C');`);
    const withMap = transformPureAnnotations(code, {filename: 'a.ts'});
    expect(withMap!.map!.mappings).toEqual(expect.any(String));
    expect(withMap!.map!.sources).toEqual(['a.ts']);
    expect(
      transformPureAnnotations(code, {sourceMap: false})!.map,
    ).toBeUndefined();
  });

  it('throws on source it cannot parse', () => {
    expect(() =>
      transformPureAnnotations(mod(`const x = createCommand(;`)),
    ).toThrow();
  });
});

describe('which calls count as a factory', () => {
  it('does not annotate a same-named function of somebody else', () => {
    // The whole point of resolving the binding: an unrelated `safeCast` or
    // `createState` in application code may well have side effects.
    expect(
      transformPureAnnotations(
        [
          `import {safeCast} from './my-utils';`,
          `export const config = safeCast({a: 1});`,
        ].join('\n'),
        {filename: path.join(__dirname, 'virtual.ts')},
      ),
    ).toBeNull();
    expect(
      transformPureAnnotations(
        [
          `import {createCommand} from 'some-cli-framework';`,
          `const command = createCommand('build');`,
        ].join('\n'),
      ),
    ).toBeNull();
  });

  it('does not annotate a same-named function declared in this module', () => {
    expect(
      transformPureAnnotations(
        [
          `function safeCast(value) {`,
          `  sideEffect();`,
          `  return value;`,
          `}`,
          `export const config = safeCast({a: 1});`,
        ].join('\n'),
      ),
    ).toBeNull();
  });

  it('annotates a call to a declaration in this module marked side-effect free', () => {
    // This is how the factory modules themselves are written: `lexical`'s
    // own commands call the `createCommand` declared right above them.
    const code = [
      `/**`,
      ` * @__NO_SIDE_EFFECTS__`,
      ` */`,
      `export function createCommand(type) {`,
      `  return {type};`,
      `}`,
      `export const MY_COMMAND = createCommand('MY_COMMAND');`,
    ].join('\n');
    expect(transform(code)).toContain(`= ${PURE}createCommand('MY_COMMAND')`);
  });

  it('annotates an aliased import from a Lexical package', () => {
    expect(
      transform(
        [
          `import {defineExtension as define} from '@lexical/extension';`,
          `export const E = define({name: 'e'});`,
        ].join('\n'),
      ),
    ).toContain(`= ${PURE}define({name: 'e'})`);
  });

  it('follows a relative import to check the declaration', () => {
    const filename = path.join(__dirname, 'virtual.ts');
    const code = [
      `import {definePureThing, defineImpureThing} from './fixtures/factories';`,
      `export const pure = definePureThing({name: 'pure'});`,
      `export const impure = defineImpureThing({name: 'impure'});`,
    ].join('\n');
    const options = {
      filename,
      functions: ['definePureThing', 'defineImpureThing'],
    };
    const result = transformPureAnnotations(code, options);
    expect(result!.code).toContain(`= ${PURE}definePureThing(`);
    expect(result!.code).toContain(`= defineImpureThing(`);
    expect(result!.count).toBe(1);

    // ...unless reading the imported module is turned off.
    expect(
      transformPureAnnotations(code, {...options, relativeImports: false}),
    ).toBeNull();
  });

  it('follows a relative import to an overloaded declaration', () => {
    // The annotation is on the first signature (a TSDeclareFunction), not on
    // the implementation that follows it.
    const result = transformPureAnnotations(
      [
        `import {defineOverloadedThing} from './fixtures/factories';`,
        `export const thing = defineOverloadedThing('x');`,
      ].join('\n'),
      {
        filename: path.join(__dirname, 'virtual.ts'),
        functions: ['defineOverloadedThing'],
      },
    );
    expect(result!.code).toContain(`= ${PURE}defineOverloadedThing('x')`);
  });

  it('respects a block that rebinds a factory name', () => {
    const result = transformPureAnnotations(
      [
        `import {safeCast} from 'lexical';`,
        `export const ok = safeCast({a: 1});`,
        `{`,
        `  const safeCast = otherLib.cast;`,
        `  shadowed = safeCast({b: 2});`,
        `}`,
      ].join('\n'),
    )!;
    expect(result.count).toBe(1);
    expect(result.code).toContain(`export const ok = ${PURE}safeCast({a: 1});`);
    expect(result.code).toContain(`shadowed = safeCast({b: 2});`);
  });

  it('accepts a custom trusted source list', () => {
    const code = [
      `import {defineExtension} from '@my-org/lexical-extras';`,
      `export const E = defineExtension({name: 'e'});`,
    ].join('\n');
    expect(transformPureAnnotations(code)).toBeNull();
    expect(
      transformPureAnnotations(code, {sources: /^@my-org\//})!.code,
    ).toContain(`= ${PURE}defineExtension(`);
  });
});

describe('pureAnnotations', () => {
  it('is shaped like a Vite plugin', () => {
    const plugin = pureAnnotations();
    // Type-level assertion: usable in a Vite (and therefore Rollup) config.
    const vitePlugin: Plugin = plugin;
    expect(vitePlugin.name).toBe('@lexical/compiler');
    expect(plugin.enforce).toBe('post');
    expect(pureAnnotations({enforce: 'pre'}).enforce).toBe('pre');
  });

  it('transforms modules and returns a source map', () => {
    const result = pureAnnotations().transform(
      mod(`export const C = createCommand('C');`),
      '/pkg/src/Commands.ts',
    );
    expect(result!.code).toContain(
      `export const C = ${PURE}createCommand('C')`,
    );
    expect(result!.map!.mappings).toEqual(expect.any(String));
  });

  it('returns null when the module does not change', () => {
    expect(
      pureAnnotations().transform(`export const x = 1;`, '/pkg/src/x.ts'),
    ).toBeNull();
  });

  it('ignores the query string a bundler appends to a module id', () => {
    const result = pureAnnotations().transform(
      mod(`export const C = createCommand('C');`),
      '/pkg/src/Commands.tsx?v=1',
    );
    expect(result!.code).toContain(`${PURE}createCommand`);
  });

  it('only transforms script modules by default', () => {
    const code = mod(`export const C = createCommand('C');`);
    expect(pureAnnotations().transform(code, '/pkg/src/styles.css')).toBeNull();
    expect(pureAnnotations().transform(code, '\0virtual:module')).toBeNull();
  });

  it('honors include and exclude', () => {
    const code = mod(`export const C = createCommand('C');`);
    const included = pureAnnotations({include: /\/wanted\//});
    expect(included.transform(code, '/pkg/wanted/a.ts')).not.toBeNull();
    expect(included.transform(code, '/pkg/other/a.ts')).toBeNull();
    const excluded = pureAnnotations({exclude: [/__tests__/]});
    expect(excluded.transform(code, '/pkg/src/__tests__/a.ts')).toBeNull();
    expect(excluded.transform(code, '/pkg/src/a.ts')).not.toBeNull();
  });

  it('warns and passes through a module it cannot parse', () => {
    const warn = vi.fn();
    const plugin = pureAnnotations() as PureAnnotationsPlugin & {
      transform: (
        this: {warn: (message: string) => void},
        code: string,
        id: string,
      ) => unknown;
    };
    expect(
      plugin.transform.call(
        {warn},
        mod(`const x = createCommand(;`),
        '/pkg/a.ts',
      ),
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('/pkg/a.ts');
  });
});
