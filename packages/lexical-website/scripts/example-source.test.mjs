/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';

import loader from '../plugins/example-source/loader.cjs';

function extract(source, region = 'sample') {
  const output = loader.call(
    {getOptions: () => ({region}), resourcePath: 'example.ts'},
    source,
  );
  return JSON.parse(output.slice('export default '.length, -1));
}

test('named regions survive extra lines and indentation changes', () => {
  const source =
    '// Intro\n\n  // [docs:sample] Read by the docs.\n  const x = 1;\n\n  const y = 2;\n  // [/docs:sample]\n// Outro';
  assert.equal(extract(source), 'const x = 1;\n\nconst y = 2;');
  assert.equal(
    extract('\n\n' + source.replaceAll('  ', '    ')),
    extract(source),
  );
});

test('nested markers stay out of rendered source', () => {
  assert.equal(
    extract(
      '// [docs:sample]\n// [docs:inner]\nexport const x = 1;\n// [/docs:inner]\n// [/docs:sample]',
    ),
    'export const x = 1;',
  );
});

test('CSS and HTML comments can mark source regions', () => {
  assert.equal(
    extract('/* [docs:sample] */\np {color: red;}\n/* [/docs:sample] */'),
    'p {color: red;}',
  );
  assert.equal(
    extract('<!-- [docs:sample] -->\n  <div></div>\n<!-- [/docs:sample] -->'),
    '<div></div>',
  );
});

test('missing, duplicated, reversed, and empty regions fail the build', () => {
  for (const source of [
    'const x = 1;',
    '// [docs:sample]\nconst x = 1;',
    '// [docs:sample]\n// [docs:sample]\nx\n// [/docs:sample]',
    '// [docs:sample]\nx\n// [/docs:sample]\n// [/docs:sample]',
    '// [/docs:sample]\nx\n// [docs:sample]',
    '// [docs:sample]\n\n// [/docs:sample]',
  ])
    assert.throws(() => extract(source), /\[docs:sample\].*example.ts/);
});
