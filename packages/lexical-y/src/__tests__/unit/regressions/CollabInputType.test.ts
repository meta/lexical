/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// YCollabConfig names every option of YCollabExtension, so code that
// spelled out a whole YCollabConfig broke each time an option was added.
// YCollabInput is what an app writes: doc, schemaVersion and layoutUpgrade
// required, every option with a default optional, so a new option is
// additive.

import {buildEditorFromExtensions} from '@lexical/extension';
import {configExtension, defineExtension} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc, type YCollabConfig, YCollabExtension} from '../../..';
import {type YCollabInput} from '../../../internal/YExtension';

// The keys an input must name: exactly doc, layoutUpgrade and
// schemaVersion.
type RequiredKeys<T> = {
  [K in keyof T]-?: Record<string, never> extends Pick<T, K> ? never : K;
}[keyof T];
const required: Record<RequiredKeys<YCollabInput>, true> = {
  doc: true,
  layoutUpgrade: true,
  schemaVersion: true,
};
// Every option of the resolved config is an option of the input: adding an
// option to one without the other fails to compile here.
const everyOption: Record<keyof YCollabConfig, keyof YCollabInput> = {
  captureTimeout: 'captureTimeout',
  convert: 'convert',
  doc: 'doc',
  layoutUpgrade: 'layoutUpgrade',
  onYStatus: 'onYStatus',
  root: 'root',
  schemaVersion: 'schemaVersion',
  selfCheck: 'selfCheck',
  selfCheckSample: 'selfCheckSample',
  synced: 'synced',
};

// N7: YCollabConfig keeps the fields it had before this release, all
// required; anything added to it is optional (its default resolved inside
// the extension). A complete object written for the old type compiles.
const configRequired: Record<RequiredKeys<YCollabConfig>, true> = {
  captureTimeout: true,
  convert: true,
  doc: true,
  root: true,
  schemaVersion: true,
  selfCheck: true,
  selfCheckSample: true,
  synced: true,
};
export function oldFullConfig(doc: YCollabInput['doc']): YCollabConfig {
  return {
    captureTimeout: 500,
    convert: false,
    doc,
    root: null,
    schemaVersion: 1,
    selfCheck: null,
    selfCheckSample: null,
    synced: false,
  };
}

export function invalidInputs(doc: YCollabInput['doc']): YCollabInput[] {
  return [
    // @ts-expect-error schemaVersion is required
    {doc, layoutUpgrade: null},
    // @ts-expect-error doc is required
    {layoutUpgrade: null, schemaVersion: 1},
    // @ts-expect-error layoutUpgrade is required
    {doc, schemaVersion: 1},
  ];
}

test('a YCollabInput with only its required keys configures the extension; the input type names every option', () => {
  expect(Object.keys(required).sort()).toEqual([
    'doc',
    'layoutUpgrade',
    'schemaVersion',
  ]);
  expect(Object.keys(everyOption)).toHaveLength(10);
  expect(Object.keys(configRequired)).toHaveLength(8);
  const input: YCollabInput = {
    doc: createYDoc(),
    layoutUpgrade: null,
    schemaVersion: 1,
  };
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [configExtension(YCollabExtension, input)],
      name: 'collab-input',
    }),
  );
  expect(editor).toBeDefined();
  editor.dispose();
  // The old complete config still configures the extension.
  const old = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        configExtension(YCollabExtension, oldFullConfig(createYDoc())),
      ],
      name: 'collab-old-full-config',
    }),
  );
  expect(old).toBeDefined();
  old.dispose();
});
