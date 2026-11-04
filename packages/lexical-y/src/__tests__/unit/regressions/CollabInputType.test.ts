/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// YCollabConfig names every option of YCollabExtension, so code that
// spelled out a whole YCollabConfig broke each time an option was added.
// YCollabInput is what an app writes: doc and schemaVersion required,
// every option with a default optional, so a new option is additive.

import {buildEditorFromExtensions} from '@lexical/extension';
import {configExtension, defineExtension} from 'lexical';
import {expect, test} from 'vitest';

import {
  createYDoc,
  type YCollabConfig,
  YCollabExtension,
  type YCollabInput,
} from '../../..';

// The keys an input must name: exactly doc and schemaVersion.
type RequiredKeys<T> = {
  [K in keyof T]-?: Record<string, never> extends Pick<T, K> ? never : K;
}[keyof T];
const required: Record<RequiredKeys<YCollabInput>, true> = {
  doc: true,
  schemaVersion: true,
};
// Every option of the resolved config is an option of the input: adding an
// option to one without the other fails to compile here.
const everyOption: Record<keyof YCollabConfig, keyof YCollabInput> = {
  captureTimeout: 'captureTimeout',
  clientIDRange: 'clientIDRange',
  convert: 'convert',
  doc: 'doc',
  root: 'root',
  schemaVersion: 'schemaVersion',
  selfCheck: 'selfCheck',
  selfCheckSample: 'selfCheckSample',
  synced: 'synced',
};

export function invalidInputs(doc: YCollabInput['doc']): YCollabInput[] {
  return [
    // @ts-expect-error schemaVersion is required
    {doc},
    // @ts-expect-error doc is required
    {schemaVersion: 1},
  ];
}

test('a YCollabInput with only doc and schemaVersion configures the extension; the input type names every option', () => {
  expect(Object.keys(required).sort()).toEqual(['doc', 'schemaVersion']);
  expect(Object.keys(everyOption)).toHaveLength(9);
  const input: YCollabInput = {doc: createYDoc(), schemaVersion: 1};
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [configExtension(YCollabExtension, input)],
      name: 'collab-input',
    }),
  );
  expect(editor).toBeDefined();
  editor.dispose();
});
