/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Plugin} from 'rollup';

import {rollup} from 'rollup';
import {describe, expect, it} from 'vitest';

import {pureAnnotations} from '../../index';

/**
 * The factories live in an external module so the bundler cannot inspect
 * their bodies and infer purity for itself. That is the situation the
 * annotations exist for: webpack and esbuild never do cross-module purity
 * inference, and Rollup only does it when the definition is in the same
 * bundle and carries the `__NO_SIDE_EFFECTS__` annotation. With the factory
 * opaque, a module-scope call is retained — even when its result is unused —
 * unless the call site says it is side-effect free.
 */
const FACTORIES = '@lexical/factories-under-test';

const ENTRY = 'entry.ts';

function virtualEntry(code: string): Plugin {
  return {
    load: (id: string) => (id === ENTRY ? code : null),
    name: 'virtual-entry',
    resolveId: (id: string) => (id === ENTRY ? id : null),
  };
}

async function bundleEntry(
  code: string,
  {annotate, inline}: {annotate: boolean; inline?: boolean},
): Promise<string> {
  const build = await rollup({
    external: [FACTORIES],
    input: ENTRY,
    plugins: [
      virtualEntry(code),
      ...(annotate ? [pureAnnotations({inline}) as Plugin] : []),
    ],
    treeshake: 'smallest',
  });
  const {output} = await build.generate({format: 'es'});
  return output[0].code;
}

describe('tree-shaking', () => {
  it('drops an unused command definition only once the call site is annotated', async () => {
    const code = [
      `import {createCommand} from '${FACTORIES}';`,
      `export const USED_COMMAND = createCommand('USED_COMMAND');`,
      `const UNUSED_COMMAND = createCommand('UNUSED_COMMAND');`,
    ].join('\n');

    // Unannotated, the call has to be assumed to have side effects: Rollup
    // drops the unreferenced binding but keeps the call itself.
    const withoutPlugin = await bundleEntry(code, {annotate: false});
    expect(withoutPlugin).toContain(`createCommand('UNUSED_COMMAND')`);

    const withPlugin = await bundleEntry(code, {annotate: true});
    expect(withPlugin).not.toContain('UNUSED_COMMAND');
    expect(withPlugin).toContain(`createCommand('USED_COMMAND')`);
  });

  it('drops an unused extension definition', async () => {
    const code = [
      `import {defineExtension} from '${FACTORIES}';`,
      `defineExtension({name: 'unused'});`,
      `export const used = 1;`,
    ].join('\n');

    expect(await bundleEntry(code, {annotate: false})).toContain(
      `defineExtension({name: 'unused'})`,
    );
    expect(await bundleEntry(code, {annotate: true})).not.toContain(
      'defineExtension(',
    );
  });

  it('needs the nested call annotated too: one impure argument pins the whole definition', async () => {
    // The outer call is annotated by hand, exactly as the sources used to be;
    // the nested `safeCast` is not. A pure call is only removable when its
    // arguments are side-effect free, so the definition survives until the
    // plugin annotates the nested call as well.
    const code = [
      `import {defineExtension, safeCast} from '${FACTORIES}';`,
      `const UnusedExtension = /* @__PURE__ */ defineExtension({`,
      `  config: safeCast({disabled: false}),`,
      `  name: 'unused',`,
      `});`,
      `export const used = 1;`,
    ].join('\n');

    expect(await bundleEntry(code, {annotate: false})).toContain('safeCast(');
    expect(await bundleEntry(code, {annotate: true})).not.toContain(
      'safeCast(',
    );
  });

  it('drops an inlined definition with no annotation involved at all', async () => {
    // With `inline`, the definition is a plain object literal, which every
    // bundler already knows it can drop — there is no annotation left to
    // preserve, and nothing pins it if a nested call is missed.
    const code = [
      `import {defineExtension, safeCast} from '${FACTORIES}';`,
      `const UnusedExtension = defineExtension({`,
      `  config: safeCast({disabled: false}),`,
      `  name: 'unused',`,
      `});`,
      `export const used = 1;`,
    ].join('\n');

    const bundled = await bundleEntry(code, {annotate: true, inline: true});
    expect(bundled).not.toContain('unused');
    expect(bundled).not.toContain('__PURE__');
    // Nothing is imported from the factory module any more either.
    expect(bundled).not.toContain(FACTORIES);
  });

  it('keeps an inlined definition that is used, as a literal', async () => {
    const code = [
      `import {defineExtension} from '${FACTORIES}';`,
      `export const UsedExtension = defineExtension({name: 'used'});`,
    ].join('\n');

    const bundled = await bundleEntry(code, {annotate: true, inline: true});
    expect(bundled).toContain(`{name: 'used'}`);
    expect(bundled).not.toContain('defineExtension(');
  });

  it('leaves a call that only runs when a function is called', async () => {
    const code = [
      `import {createCommand} from '${FACTORIES}';`,
      `export function makeLate() {`,
      `  return createCommand('LATE_COMMAND');`,
      `}`,
    ].join('\n');

    expect(await bundleEntry(code, {annotate: true})).toContain(
      `createCommand('LATE_COMMAND')`,
    );
  });
});
