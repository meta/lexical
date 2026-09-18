/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {parse} from '@babel/parser';
import {defineImportRule} from '@lexical/html';
import {glob} from 'glob';
import {
  configExtension,
  declarePeerDependency,
  defineExtension,
  safeCast,
} from 'lexical';
import * as fs from 'node:fs';
import {describe, expect, it} from 'vitest';

import {
  INLINE_FACTORY_FORMS,
  PURE_FACTORY_FUNCTIONS,
  transformPureAnnotations,
} from '../../index';

const PURE = '/* @__PURE__ */';

/** Values the sample calls are made with, by the name used in the source. */
const SCOPE: Record<string, unknown> = {
  CONFIG: {disabled: false},
  EXTENSION: {name: 'other'},
  RULE: {match: 'p', name: 'rule'},
};

function inline(code: string, filename = 'test.ts') {
  return transformPureAnnotations(code, {filename, inline: true});
}

/**
 * Evaluate an expression from the transform's output against the same values
 * the real factory is called with.
 */
function evaluate(expression: string): unknown {
  const names = Object.keys(SCOPE);
  // eslint-disable-next-line no-new-func -- comparing emitted code to the real function is the point
  return new Function(...names, `return (${expression});`)(
    ...names.map(name => SCOPE[name]),
  );
}

/**
 * Transform `<name>(<args>)` imported from `<specifier>` and return the
 * expression the factory call was replaced with.
 */
function inlinedExpression(
  name: string,
  specifier: string,
  args: string,
): string {
  const result = inline(
    [
      `import {${name}} from '${specifier}';`,
      `export const value = ${name}(${args});`,
    ].join('\n'),
  );
  expect(result).not.toBeNull();
  expect(result!.inlined).toBe(1);
  const {code} = result!;
  return code.slice(code.indexOf('= ') + 2, code.lastIndexOf(';'));
}

describe('inlining', () => {
  it('replaces an identity factory with its argument', () => {
    expect(
      inline(
        [
          `import {safeCast} from 'lexical';`,
          `export const config = safeCast<Config>({disabled: false});`,
          `export const other = safeCast({a: 1});`,
        ].join('\n'),
      )!.code,
    ).toBe(
      [
        // The import goes with the last call to it; see below.
        ``,
        `export const config = {disabled: false};`,
        `export const other = {a: 1};`,
      ].join('\n'),
    );
  });

  it('replaces an args factory with an array of its arguments', () => {
    expect(
      inline(
        [
          `import {configExtension} from '@lexical/extension';`,
          `export const dep = configExtension(Other, {a: 1});`,
        ].join('\n'),
      )!.code,
    ).toContain(`export const dep = ([Other, {a: 1}]);`);
  });

  it('leaves nothing to annotate once the whole definition is a literal', () => {
    const result = inline(
      [
        `import {defineExtension, safeCast} from 'lexical';`,
        `export const E = defineExtension({`,
        `  config: safeCast<Config>({disabled: false}),`,
        `  name: 'e',`,
        `});`,
      ].join('\n'),
    )!;
    expect(result.count).toBe(0);
    expect(result.inlined).toBe(2);
    expect(result.code).not.toContain('__PURE__');
    expect(result.code).toContain(`export const E = {`);
  });

  it('removes an annotation that would be left in front of a literal', () => {
    const result = inline(
      [
        `import {defineExtension} from 'lexical';`,
        `export const E = ${PURE}defineExtension({name: 'e'});`,
      ].join('\n'),
    )!;
    expect(result.code).toContain(`export const E = {name: 'e'};`);
    expect(result.code).not.toContain('__PURE__');
  });

  it('annotates rather than inlines when the call does not fit the form', () => {
    // A spread argument cannot be mapped onto a single parameter.
    const result = inline(
      [
        `import {safeCast} from 'lexical';`,
        `export const c = safeCast(...values);`,
      ].join('\n'),
    )!;
    expect(result.inlined).toBe(0);
    expect(result.count).toBe(1);
  });

  it('inlines a peer dependency declared without a config', () => {
    // `declarePeerDependency` returns its arguments, so one argument gives a
    // one element tuple — which is what `NormalizedPeerDependency` describes.
    expect(
      inline(
        [
          `import {declarePeerDependency} from 'lexical';`,
          `export const p = declarePeerDependency('peer');`,
          `export const q = declarePeerDependency('other', {a: 1});`,
        ].join('\n'),
      )!.code,
    ).toBe(
      [
        ``,
        `export const p = (['peer']);`,
        `export const q = (['other', {a: 1}]);`,
      ].join('\n'),
    );
  });

  it('leaves a call whose result is discarded alone', () => {
    // `{name: 'e'};` as a statement is a block, not an object.
    const result = inline(
      [
        `import {defineExtension} from 'lexical';`,
        `defineExtension({name: 'e'});`,
      ].join('\n'),
    )!;
    expect(result.inlined).toBe(0);
    expect(result.code).toContain(`${PURE}defineExtension({name: 'e'});`);
  });

  it('fails on a marker naming a form it does not implement', () => {
    // A typo would otherwise leave the factory quietly un-inlined, which is
    // exactly what the marker exists to prevent.
    const declaration = (marker: string) =>
      [
        `/**`,
        ` * @__NO_SIDE_EFFECTS__`,
        ` * ${marker}`,
        ` */`,
        `export function mk(a) { return a; }`,
        `export const v = mk({x: 1});`,
      ].join('\n');
    const options = {filename: '/repo/src/mk.ts', functions: ['mk']};
    expect(() =>
      transformPureAnnotations(declaration('@lexical-inline tuple'), options),
    ).toThrow(
      /unknown @lexical-inline form "tuple" in \/repo\/src\/mk\.ts.*args, identity/s,
    );
    expect(() =>
      transformPureAnnotations(declaration('@lexical-inline'), options),
    ).toThrow(/\(none given\)/);
    expect(() =>
      transformPureAnnotations(
        declaration('@lexical-inline identity'),
        options,
      ),
    ).not.toThrow();
  });

  it('lets a factory of your own authorize its own inlining', () => {
    // For a name that is not one of Lexical's, the marker is the only thing
    // that says what a call may be replaced with.
    const code = [
      `/**`,
      ` * @__NO_SIDE_EFFECTS__`,
      ` * @lexical-inline identity`,
      ` */`,
      `export function mk(a) { return a; }`,
      `export const v = mk({x: 1});`,
    ].join('\n');
    const result = transformPureAnnotations(code, {
      filename: '/repo/src/mk.ts',
      functions: ['mk'],
      inline: true,
    })!;
    expect(result.code).toContain(`export const v = {x: 1};`);
    expect(result.inlined).toBe(1);
  });

  it('keeps parentheses an argument was written with', () => {
    // The argument's own extent stops short of them, so slicing there would
    // leave `([Ext, (cfg])`.
    expect(
      inline(
        [
          `import {configExtension} from 'lexical';`,
          `export const d = configExtension(Ext, (cfg));`,
        ].join('\n'),
      )!.code,
    ).toContain(`export const d = ([Ext, (cfg)]);`);
  });

  it('keeps a sequence argument a single element', () => {
    // `declarePeerDependency((a, b))` passes one argument, so it returns a
    // one element tuple; splitting on the comma would make it two.
    expect(
      inline(
        [
          `import {declarePeerDependency} from 'lexical';`,
          `export const p = declarePeerDependency((a, b));`,
        ].join('\n'),
      )!.code,
    ).toContain(`export const p = ([(a, b)]);`);
  });

  it('handles type arguments and a trailing comma', () => {
    expect(
      inline(
        [
          `import {configExtension} from 'lexical';`,
          `export const t = configExtension<Cfg>(Ext, {a: 1},);`,
        ].join('\n'),
      )!.code,
    ).toContain(`export const t = ([Ext, {a: 1},]);`);
  });

  it('leaves an optional call alone', () => {
    // `factory?.(x)` is undefined when the factory is missing, so it is not
    // interchangeable with what the factory returns.
    expect(
      inline(
        [
          `import {safeCast} from 'lexical';`,
          `export const c = safeCast?.({a: 1});`,
        ].join('\n'),
      ),
    ).toBeNull();
  });

  it('removes a run of unused specifiers without stranding a comma', () => {
    // Removing two adjacent specifiers as separate ranges overlaps, and the
    // comma of the first survives: `import {createCommand, } from 'lexical'`.
    expect(
      inline(
        [
          `import {createCommand, defineExtension, safeCast} from 'lexical';`,
          `export const C = createCommand('C');`,
          `export const E = defineExtension({config: safeCast({a: 1}), name: 'e'});`,
        ].join('\n'),
      )!.code,
    ).toBe(
      [
        `import {createCommand} from 'lexical';`,
        `export const C = ${PURE}createCommand('C');`,
        `export const E = {config: {a: 1}, name: 'e'};`,
      ].join('\n'),
    );
  });

  it('parenthesizes the array so it binds where the call did', () => {
    // Without the parentheses ASI reads the `[` as a member access on
    // whatever the previous line ended with: `f()[A, {}].length`.
    expect(
      inline(
        [
          `import {configExtension} from 'lexical';`,
          `const x = f()`,
          `configExtension(A, {}).length;`,
        ].join('\n'),
      )!.code,
    ).toBe(['', `const x = f()`, `([A, {}]).length;`].join('\n'));
  });

  it('keeps the annotation on a nested call it inlines around', () => {
    // The annotation is appended where the nested call begins, which is
    // inside the range the enclosing call's `factory(` is overwritten with.
    expect(
      inline(
        [
          `import {createCommand, defineExtension} from 'lexical';`,
          `export const E = defineExtension(createCommand('X'));`,
        ].join('\n'),
      )!.code,
    ).toBe(
      [
        `import {createCommand} from 'lexical';`,
        `export const E = (${PURE}createCommand('X'));`,
      ].join('\n'),
    );
  });

  it('removes the import once nothing calls the factory any more', () => {
    expect(
      inline(
        [
          `import {defineExtension} from 'lexical';`,
          `export const E = defineExtension({name: 'e'});`,
        ].join('\n'),
      )!.code,
    ).toBe(['', `export const E = {name: 'e'};`].join('\n'));
  });

  it('keeps the specifiers that are still used', () => {
    expect(
      inline(
        [
          `import {createCommand, defineExtension} from 'lexical';`,
          `export const C = createCommand('C');`,
          `export const E = defineExtension({name: 'e'});`,
        ].join('\n'),
      )!.code,
    ).toBe(
      [
        `import {createCommand} from 'lexical';`,
        `export const C = ${PURE}createCommand('C');`,
        `export const E = {name: 'e'};`,
      ].join('\n'),
    );
  });

  it('keeps an import that is still referenced from inside a function', () => {
    const result = inline(
      [
        `import {safeCast} from 'lexical';`,
        `export const config = safeCast({a: 1});`,
        `export function later() {`,
        `  return safeCast({b: 2});`,
        `}`,
      ].join('\n'),
    )!;
    expect(result.code).toContain(`import {safeCast} from 'lexical';`);
    expect(result.code).toContain(`export const config = {a: 1};`);
  });

  it('keeps an import that is referenced as a value', () => {
    const result = inline(
      [
        `import {safeCast} from 'lexical';`,
        `export const config = safeCast({a: 1});`,
        `export const alias = safeCast;`,
      ].join('\n'),
    )!;
    expect(result.code).toContain(`import {safeCast} from 'lexical';`);
  });

  it('keeps an import that is re-exported', () => {
    const result = inline(
      [
        `import {defineExtension} from 'lexical';`,
        `export const E = defineExtension({name: 'e'});`,
        `export {defineExtension};`,
      ].join('\n'),
    )!;
    expect(result.code).toContain(`import {defineExtension} from 'lexical';`);
    expect(result.code).toContain(`export const E = {name: 'e'};`);
  });

  it('keeps an import that is re-exported under another name', () => {
    const result = inline(
      [
        `import {safeCast} from 'lexical';`,
        `export const config = safeCast({a: 1});`,
        `export {safeCast as castSafely};`,
      ].join('\n'),
    )!;
    expect(result.code).toContain(`import {safeCast} from 'lexical';`);
  });

  it('does not mistake a property of the same name for a reference', () => {
    const result = inline(
      [
        `import {defineExtension} from 'lexical';`,
        `export const E = defineExtension({name: 'e'});`,
        `export const shape = {defineExtension: 1};`,
        `export const read = shape.defineExtension;`,
      ].join('\n'),
    )!;
    expect(result.code).not.toContain('import {');
  });

  it('keeps the parentheses when the argument is not self-delimiting', () => {
    // `safeCast(1 + 2) * 3` is 9; `1 + 2 * 3` is 7.
    const result = inline(
      [
        `import {safeCast} from 'lexical';`,
        `export const x = safeCast(1 + 2) * 3;`,
        `export const y = safeCast(a || b).c;`,
        `export const z = safeCast({a: 1});`,
      ].join('\n'),
    )!;
    expect(result.code).toContain(`export const x = (1 + 2) * 3;`);
    expect(result.code).toContain(`export const y = (a || b).c;`);
    // An object literal needs no help.
    expect(result.code).toContain(`export const z = {a: 1};`);
  });

  it('keeps the parentheses at the start of an expression statement', () => {
    // `{name: 'e'}.name;` would be a block followed by a member expression.
    const result = inline(
      [
        `import {defineExtension} from 'lexical';`,
        `defineExtension({name: 'e'}).name;`,
      ].join('\n'),
    )!;
    expect(result.code).toContain(`({name: 'e'}).name;`);
  });

  it('requires the marker to inline a factory it can see the source of', () => {
    // Being side-effect free is what makes a call safe to *annotate*. It says
    // nothing about the shape of what comes back, so a look-alike that is not
    // marked inlinable is annotated instead.
    const unmarked = inline(
      [
        `/**`,
        ` * @__NO_SIDE_EFFECTS__`,
        ` */`,
        `function defineExtension(config) {`,
        `  return {...config, extra: 1};`,
        `}`,
        `export const E = defineExtension({name: 'e'});`,
      ].join('\n'),
    )!;
    expect(unmarked.inlined).toBe(0);
    expect(unmarked.code).toContain(`${PURE}defineExtension({name: 'e'})`);

    const marked = inline(
      [
        `/**`,
        ` * @__NO_SIDE_EFFECTS__`,
        ` * @lexical-inline identity`,
        ` */`,
        `function defineExtension(config) {`,
        `  return config;`,
        `}`,
        `export const E = defineExtension({name: 'e'});`,
      ].join('\n'),
    )!;
    expect(marked.inlined).toBe(1);
    expect(marked.code).toContain(`export const E = {name: 'e'};`);
  });

  it('leaves the rest of an import declaration intact', () => {
    const withDefault = inline(
      [
        `import React, {safeCast} from 'lexical';`,
        `export const config = safeCast({a: 1});`,
        `export const element = React;`,
      ].join('\n'),
    )!;
    expect(withDefault.code).toContain(`import React from 'lexical';`);

    const withNamespace = inline(
      [
        `import * as L from 'lexical';`,
        `import {safeCast} from 'lexical';`,
        `export const config = safeCast({a: 1});`,
        `export const all = L;`,
      ].join('\n'),
    )!;
    expect(withNamespace.code).toContain(`import * as L from 'lexical';`);
  });

  it('does not inline unless asked to', () => {
    const code = [
      `import {safeCast} from 'lexical';`,
      `export const config = safeCast({disabled: false});`,
    ].join('\n');
    const result = transformPureAnnotations(code, {filename: 'test.ts'})!;
    expect(result.inlined).toBe(0);
    expect(result.code).toContain(`${PURE}safeCast(`);
  });

  it('only inlines factories that resolve to Lexical', () => {
    expect(
      transformPureAnnotations(
        [
          `import {safeCast} from 'some-other-library';`,
          `export const config = safeCast({disabled: false});`,
        ].join('\n'),
        {filename: 'test.ts', inline: true},
      ),
    ).toBeNull();
  });
});

describe('the inlined factories are still trivial', () => {
  // These replacements are only correct while the factories really do return
  // a trivial expression over their arguments. Compare what the transform
  // emits against what the real function returns, so that changing one of
  // them without updating the transform fails here rather than silently
  // producing wrong code in somebody's bundle.
  it('safeCast returns its argument', () => {
    const expression = inlinedExpression('safeCast', 'lexical', 'CONFIG');
    expect(evaluate(expression)).toBe(safeCast(SCOPE.CONFIG));
    expect(evaluate(expression)).toBe(SCOPE.CONFIG);
  });

  it('defineExtension returns its argument', () => {
    const expression = inlinedExpression(
      'defineExtension',
      'lexical',
      'EXTENSION',
    );
    expect(evaluate(expression)).toBe(
      defineExtension(SCOPE.EXTENSION as Parameters<typeof defineExtension>[0]),
    );
  });

  it('defineImportRule returns its argument', () => {
    const expression = inlinedExpression(
      'defineImportRule',
      '@lexical/html',
      'RULE',
    );
    expect(evaluate(expression)).toBe(
      defineImportRule(SCOPE.RULE as Parameters<typeof defineImportRule>[0]),
    );
  });

  it('configExtension returns its arguments as an array', () => {
    const expression = inlinedExpression(
      'configExtension',
      '@lexical/extension',
      'EXTENSION, CONFIG',
    );
    expect(evaluate(expression)).toEqual(
      configExtension(
        ...([SCOPE.EXTENSION, SCOPE.CONFIG] as Parameters<
          typeof configExtension
        >),
      ),
    );
  });

  it('declarePeerDependency returns its arguments as an array', () => {
    // The generic is what gives `name` and `config` their types; this test is
    // about what the function returns at runtime, for both arities.
    const declarePeer = declarePeerDependency as (
      name: string,
      config?: unknown,
    ) => unknown;
    expect(
      evaluate(inlinedExpression('declarePeerDependency', 'lexical', `'peer'`)),
    ).toEqual(declarePeer('peer'));
    expect(
      evaluate(
        inlinedExpression('declarePeerDependency', 'lexical', `'peer', CONFIG`),
      ),
    ).toEqual(declarePeer('peer', SCOPE.CONFIG));
  });

  it('every factory in the list declares itself side-effect free', () => {
    // The list is what makes a call site trusted when the factory is
    // imported by package name; the annotation on the declaration is what
    // makes it trusted anywhere else, including from inside its own
    // package. A name in one and not the other is a hole.
    const declared = new Set<string>();
    for (const file of glob.sync('packages/*/src/**/*.{ts,tsx}', {
      ignore: ['**/__tests__/**'],
      windowsPathsNoEscape: true,
    })) {
      const code = fs.readFileSync(file, 'utf8');
      if (!code.includes('NO_SIDE_EFFECTS__')) {
        continue;
      }
      const ast = parse(code, {plugins: ['typescript'], sourceType: 'module'});
      for (const statement of ast.program.body) {
        const declaration =
          statement.type === 'ExportNamedDeclaration' && statement.declaration
            ? statement.declaration
            : statement;
        const marked = (statement.leadingComments || []).some(comment =>
          /[#@]__NO_SIDE_EFFECTS__/.test(comment.value),
        );
        if (
          marked &&
          (declaration.type === 'FunctionDeclaration' ||
            declaration.type === 'TSDeclareFunction') &&
          declaration.id
        ) {
          declared.add(declaration.id.name);
        }
      }
    }
    expect(PURE_FACTORY_FUNCTIONS.filter(name => !declared.has(name))).toEqual(
      [],
    );
  });

  it('is marked as inlinable wherever it is defined', () => {
    // The marker is the other half of the contract: it tells whoever edits
    // one of these functions that its body is being reproduced by the build.
    const marked = new Map<string, string>();
    for (const file of glob.sync('packages/*/src/**/*.{ts,tsx}', {
      ignore: ['**/__tests__/**'],
      windowsPathsNoEscape: true,
    })) {
      const code = fs.readFileSync(file, 'utf8');
      if (!code.includes('@lexical-inline')) {
        continue;
      }
      const ast = parse(code, {plugins: ['typescript'], sourceType: 'module'});
      for (const statement of ast.program.body) {
        const declaration =
          statement.type === 'ExportNamedDeclaration' && statement.declaration
            ? statement.declaration
            : statement;
        const marker = (statement.leadingComments || [])
          .map(comment => /@lexical-inline\s+(\w+)/.exec(comment.value))
          .find(Boolean);
        if (marker && declaration.type === 'FunctionDeclaration') {
          marked.set(declaration.id!.name, marker[1]);
        }
      }
    }
    expect(Object.fromEntries(marked)).toEqual(
      Object.fromEntries(INLINE_FACTORY_FORMS),
    );
  });
});
