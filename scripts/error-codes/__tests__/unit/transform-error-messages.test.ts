/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import * as babel from '@babel/core';
import prettier from '@prettier/sync';
import * as fs from 'fs-extra';
import * as path from 'node:path';
import {rollup} from 'rollup';
import {describe, expect, it} from 'vitest';

import transformErrorMessages from '../../transform-error-messages.mjs';

const prettierConfig = prettier.resolveConfig(__filename) || {};

function waitTick(): Promise<void> {
  return new Promise(resolve => queueMicrotask(resolve));
}

async function withCodes(
  before: Record<string, string>,
  after: Record<string, string>,
  cb: (errorCodesPath: string) => Promise<void> | void,
) {
  const tmpdir = fs.mkdtempSync('transform-error-messages');
  try {
    const errorCodesPath = path.join(tmpdir, 'codes.json');
    fs.writeJsonSync(errorCodesPath, before);
    await cb(errorCodesPath);
    await waitTick();
    expect(fs.readJsonSync(errorCodesPath)).toEqual(after);
  } finally {
    fs.removeSync(tmpdir);
  }
}

function fmt(strings: TemplateStringsArray, ...keys: unknown[]): string {
  const result = [strings[0]];
  keys.forEach((key, i) => {
    result.push(String(key), strings[i + 1]);
  });
  // Normalize some of the stuff that babel will inject so the examples are
  // stable and easier to read:
  // - use strict header
  // - @babel/helper-module-imports interop (CJS require + ESM import forms)
  const before = result
    .join('')
    .replace(/.use strict.;\n/g, '')
    .replace(/var _[^;]+;\n/g, '')
    .replace(/import [^;]*?from ['"]@lexical\/internal\/[^'"]+['"];\n?/g, '')
    .replace(/function _interopRequireDefault\([^)]*\) {[^;]+?;[\s\n]*}\n/g, '')
    .replace(/_format(Dev|Prod)(Error|Warning)Message\d*/g, 'format$1$2Message')
    .replace(/_createProdError\d*/g, 'createProdError')
    .replace(/\(0,\s*createProdError\.default\)/g, 'createProdError')
    .replace(/_createError\d*/g, 'createError')
    .replace(/\(0,\s*createError\.default\)/g, 'createError')
    .replace(/_createDevError\d*/g, 'createDevError')
    .replace(/\(0,\s*createDevError\.default\)/g, 'createDevError')
    .replace(
      /\(0,\s*format(Dev|Prod)(Error|Warning)Message\.default\)/g,
      'format$1$2Message',
    )
    .trim();
  return prettier.format(before, {
    ...prettierConfig,
    filepath: 'test.js',
  });
}

const NEW_MSG = 'A new invariant';
const KNOWN_MSG = 'A %s message that contains %s';
const KNOWN_MSG_MAP = Object.fromEntries(
  [KNOWN_MSG].map((msg, i) => [String(i), msg]),
);
const NEW_MSG_MAP = Object.fromEntries(
  [KNOWN_MSG, NEW_MSG].map((msg, i) => [String(i), msg]),
);

interface ExpectTransformOptions {
  codeBefore: string;
  codeExpect: string;
  messageMapBefore: Record<string, string>;
  messageMapExpect: Record<string, string>;
  opts: Partial<
    import('../../transform-error-messages').TransformErrorMessagesOptions
  >;
}

async function expectTransform(opts: ExpectTransformOptions) {
  return await withCodes(
    opts.messageMapBefore,
    opts.messageMapExpect,
    async errorCodesPath => {
      const {code} = babel.transformSync(opts.codeBefore, {
        configFile: false,
        plugins: [[transformErrorMessages, {errorCodesPath, ...opts.opts}]],
        presets: [
          [
            '@babel/preset-env',
            {
              targets: {
                node: 'current',
              },
            },
          ],
        ],
      })!;
      expect(fmt`${code}`).toEqual(fmt`${opts.codeExpect}`);
    },
  );
}

describe('transform-error-messages', () => {
  describe('createError', () => {
    it.each(['', '.js'])(
      'recognizes an aliased default import from createError%s',
      async extension => {
        await expectTransform({
          codeBefore: `import makeError from '@lexical/internal/createError${extension}';
            const error = makeError(${JSON.stringify(KNOWN_MSG)}, adj, noun);`,
          codeExpect: 'const error = createProdError(0, adj, noun);',
          messageMapBefore: KNOWN_MSG_MAP,
          messageMapExpect: KNOWN_MSG_MAP,
          opts: {noMinify: false},
        });
      },
    );

    it.each([
      'function createError(message) { return new Error(message); }',
      "import createError from 'another-package';",
    ])('does not rewrite unrelated functions: %s', async declaration => {
      const code = `${declaration}
        createError('A new invariant');
        createError(message);`;
      await expectTransform({
        codeBefore: code,
        codeExpect: code,
        messageMapBefore: KNOWN_MSG_MAP,
        messageMapExpect: KNOWN_MSG_MAP,
        opts: {extractCodes: true, noMinify: false},
      });
    });

    it('does not rewrite a shadowed import', async () => {
      await expectTransform({
        codeBefore: `import createError from '@lexical/internal/createError';
          function run(createError, message) {
            return createError(message);
          }
          const error = createError(${JSON.stringify(KNOWN_MSG)}, adj, noun);`,
        codeExpect: `function run(createError, message) {
            return createError(message);
          }
          const error = createProdError(0, adj, noun);`,
        messageMapBefore: KNOWN_MSG_MAP,
        messageMapExpect: KNOWN_MSG_MAP,
        opts: {noMinify: false},
      });
    });

    it.each([true, false])(
      'can transform bundled errors again (noMinify: %s)',
      async noMinify => {
        await withCodes(KNOWN_MSG_MAP, KNOWN_MSG_MAP, async errorCodesPath => {
          const entry = path.resolve('error-factory-entry.ts');
          const internalDir = path.resolve('packages/lexical-internal/src');
          const bundle = await rollup({
            input: entry,
            plugins: [
              {
                load(id) {
                  return id === entry
                    ? `import createError from '@lexical/internal/createError';
                       export const known = createError(${JSON.stringify(KNOWN_MSG)}, 'test', 'an argument');
                       export const unknown = createError(${JSON.stringify(NEW_MSG)});`
                    : fs.readFileSync(id, 'utf8');
                },
                name: 'error-factory-regression',
                resolveId(id, importer) {
                  if (id === entry) return entry;
                  if (id.startsWith('@lexical/internal/')) {
                    return path.join(internalDir, id.split('/').pop() + '.ts');
                  }
                  if (importer && id.startsWith('.')) {
                    return path.resolve(path.dirname(importer), id + '.ts');
                  }
                  return null;
                },
                transform(code, id) {
                  return babel.transformSync(code, {
                    configFile: false,
                    filename: id,
                    plugins: [
                      [transformErrorMessages, {errorCodesPath, noMinify}],
                    ],
                    presets: ['@babel/preset-typescript'],
                  })!.code;
                },
              },
            ],
          });
          try {
            const {output} = await bundle.generate({format: 'es'});
            const code = output[0].code;
            const secondPass = babel.transformSync(code, {
              configFile: false,
              plugins: [
                [transformErrorMessages, {errorCodesPath, noMinify: true}],
              ],
            })!.code;
            expect(secondPass).toBe(
              babel.transformSync(code, {configFile: false})!.code,
            );
          } finally {
            await bundle.close();
          }
        });
      },
    );

    it.each([false, true])(
      'extracts codes while preserving expression context (noMinify: %s)',
      async noMinify => {
        await expectTransform({
          codeBefore: `
            import createError from '@lexical/internal/createError';
            const error = createError(${JSON.stringify(NEW_MSG)});
            editor._onWarn(createError(${JSON.stringify(KNOWN_MSG)}, adj, noun));
          `,
          codeExpect: noMinify
            ? `
                const error = createDevError(\`A new invariant\`);
                editor._onWarn(createDevError(\`A \${adj} message that contains \${noun}\`));
              `
            : `
                const error = createProdError(1);
                editor._onWarn(createProdError(0, adj, noun));
              `,
          messageMapBefore: KNOWN_MSG_MAP,
          messageMapExpect: NEW_MSG_MAP,
          opts: {extractCodes: true, noMinify},
        });
      },
    );

    it('uses an existing code without extracting new ones', async () => {
      await expectTransform({
        codeBefore: `import createError from '@lexical/internal/createError';
          const makeError = () => createError(${JSON.stringify(KNOWN_MSG)}, adj, noun);`,
        codeExpect: 'const makeError = () => createProdError(0, adj, noun);',
        messageMapBefore: KNOWN_MSG_MAP,
        messageMapExpect: KNOWN_MSG_MAP,
        opts: {extractCodes: false, noMinify: false},
      });
    });

    it('keeps uncoded production errors usable without throwing', async () => {
      await expectTransform({
        codeBefore: `import createError from '@lexical/internal/createError';
          editor._onWarn(createError(${JSON.stringify(NEW_MSG)}));`,
        codeExpect: `editor._onWarn(
          /*FIXME (minify-errors-in-prod): Unminified error message in production build!*/ createDevError(\`A new invariant\`)
        );`,
        messageMapBefore: KNOWN_MSG_MAP,
        messageMapExpect: KNOWN_MSG_MAP,
        opts: {extractCodes: false, noMinify: false},
      });
    });
  });

  describe('invariant', () => {
    describe('{extractCodes: true, noMinify: false}', () => {
      const opts = {extractCodes: true, noMinify: false};
      it('inserts known and extracts unknown message codes', async () => {
        await expectTransform({
          codeBefore: `
        invariant(condition, ${JSON.stringify(NEW_MSG)});
        invariant(condition, ${JSON.stringify(KNOWN_MSG)}, adj, noun);
        `,
          codeExpect: `
        if (!condition) {
          formatProdErrorMessage(1);
        }
        if (!condition) {
          formatProdErrorMessage(0, adj, noun);
        }`,
          messageMapBefore: KNOWN_MSG_MAP,
          messageMapExpect: NEW_MSG_MAP,
          opts,
        });
      });
    });
    describe('{extractCodes: true, noMinify: true}', () => {
      const opts = {extractCodes: true, noMinify: true};
      it('inserts known and extracts unknown message codes', async () => {
        await expectTransform({
          codeBefore: `
        invariant(condition, ${JSON.stringify(NEW_MSG)});
        invariant(condition, ${JSON.stringify(KNOWN_MSG)}, adj, noun);
        `,
          codeExpect: `
        if (!condition) {
          formatDevErrorMessage(\`A new invariant\`);
        }
        if (!condition) {
          formatDevErrorMessage(\`A \${adj} message that contains \${noun}\`);
        }`,
          messageMapBefore: KNOWN_MSG_MAP,
          messageMapExpect: NEW_MSG_MAP,
          opts,
        });
      });
    });
    describe('{extractCodes: false, noMinify: false}', () => {
      const opts = {extractCodes: false, noMinify: false};
      it('inserts known message', async () => {
        await expectTransform({
          codeBefore: `invariant(condition, ${JSON.stringify(
            KNOWN_MSG,
          )}, adj, noun)`,
          codeExpect: `
          if (!condition) {
            formatProdErrorMessage(0, adj, noun);
          }
        `,
          messageMapBefore: KNOWN_MSG_MAP,
          messageMapExpect: KNOWN_MSG_MAP,
          opts,
        });
      });
      it('inserts warning comment for unknown messages', async () => {
        await expectTransform({
          codeBefore: `invariant(condition, ${JSON.stringify(NEW_MSG)})`,
          codeExpect: `
          /*FIXME (minify-errors-in-prod): Unminified error message in production build!*/
          if (!condition) {
            formatDevErrorMessage(\`A new invariant\`);
          }
       `,
          messageMapBefore: KNOWN_MSG_MAP,
          messageMapExpect: KNOWN_MSG_MAP,
          opts,
        });
      });
    });
  });
  describe('devInvariant', () => {
    describe('{extractCodes: true, noMinify: false}', () => {
      const opts = {extractCodes: true, noMinify: false};
      it('inserts known and extracts unknown message codes', async () => {
        await expectTransform({
          codeBefore: `
        devInvariant(condition, ${JSON.stringify(NEW_MSG)});
        devInvariant(condition, ${JSON.stringify(KNOWN_MSG)}, adj, noun);
        `,
          codeExpect: `
        if (!condition) {
          formatProdWarningMessage(1);
        }
        if (!condition) {
          formatProdWarningMessage(0, adj, noun);
        }`,
          messageMapBefore: KNOWN_MSG_MAP,
          messageMapExpect: NEW_MSG_MAP,
          opts,
        });
      });
    });
    describe('{extractCodes: true, noMinify: true}', () => {
      const opts = {extractCodes: true, noMinify: true};
      it('inserts known and extracts unknown message codes', async () => {
        await expectTransform({
          codeBefore: `
        devInvariant(condition, ${JSON.stringify(NEW_MSG)});
        devInvariant(condition, ${JSON.stringify(KNOWN_MSG)}, adj, noun);
        `,
          codeExpect: `
        if (!condition) {
          formatDevErrorMessage(\`A new invariant\`);
        }
        if (!condition) {
          formatDevErrorMessage(\`A \${adj} message that contains \${noun}\`);
        }`,
          messageMapBefore: KNOWN_MSG_MAP,
          messageMapExpect: NEW_MSG_MAP,
          opts,
        });
      });
    });
    describe('{extractCodes: false, noMinify: false}', () => {
      const opts = {extractCodes: false, noMinify: false};
      it('inserts known message', async () => {
        await expectTransform({
          codeBefore: `devInvariant(condition, ${JSON.stringify(
            KNOWN_MSG,
          )}, adj, noun)`,
          codeExpect: `
          if (!condition) {
            formatProdWarningMessage(0, adj, noun);
          }
        `,
          messageMapBefore: KNOWN_MSG_MAP,
          messageMapExpect: KNOWN_MSG_MAP,
          opts,
        });
      });
      it('inserts warning comment for unknown messages', async () => {
        await expectTransform({
          codeBefore: `devInvariant(condition, ${JSON.stringify(NEW_MSG)})`,
          codeExpect: `
          /*FIXME (minify-errors-in-prod): Unminified error message in production build!*/
          if (!condition) {
            formatDevWarningMessage(\`A new invariant\`);
          }
       `,
          messageMapBefore: KNOWN_MSG_MAP,
          messageMapExpect: KNOWN_MSG_MAP,
          opts,
        });
      });
    });
  });
});
