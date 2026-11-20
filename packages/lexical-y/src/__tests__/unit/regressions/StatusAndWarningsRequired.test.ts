/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// D135: a status handler, the sync choice and a headless warning handler
// are decisions, not defaults.
//
// Before: `onYStatus` (YCollabExtension, createYCollabConfig) and
// `onStatus` (YBinding) were optional, so an app could bind with nothing
// that showed a read-only document's cause; read only with
// `unstorable-change`, the editor holds an edit the document does not, and
// an app that never learns it never takes it (`freeze()`), so it is lost
// on reload. The extension's `status` signal carried no cause, and did not
// move when `freeze()` froze a binding already read only. `synced` was
// optional (a forgotten `markSynced` left the editor pending for good),
// and the headless config's `onWarn` was optional, its default silent in
// production, where `seedYState` and `readYState` return warnings nowhere
// else.

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  configExtension,
  createEditor,
  defineExtension,
} from 'lexical';
import {expect, test} from 'vitest';

import {
  createYCollabConfig,
  createYDoc,
  YBinding,
  YCollabExtension,
  type YCollabInput,
  type YStatus,
} from '../../..';
import {readYState, seedYState} from '../../../headless';
import {NODES} from '../../utils/harness';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function build(
  doc: ReturnType<typeof createYDoc>,
  config: Record<string, unknown>,
) {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [configExtension(YCollabExtension, config as never)],
      name: 'status-required',
      nodes: NODES,
      onError: error => {
        throw error;
      },
      onWarn: () => {},
    }),
  );
}

test('YCollabExtension refuses a config without onYStatus, naming the fix', () => {
  expect(() =>
    build(createYDoc(), {doc: createYDoc(), schemaVersion: 1}),
  ).toThrow(/YCollabExtension needs onYStatus: a function that shows the user/);
  const editor = build(createYDoc(), {
    doc: createYDoc(),
    onYStatus: null,
    schemaVersion: 1,
  });
  editor.dispose();
});

test('YBinding refuses options without onStatus (JavaScript), naming the fix', () => {
  const editor = createEditor({nodes: NODES});
  expect(
    () => new YBinding(editor, createYDoc(), {schemaVersion: 1} as never),
  ).toThrow(/YBinding needs options\.onStatus/);
});

test('createYCollabConfig types every decision as required', () => {
  const doc = createYDoc();
  // @ts-expect-error -- onYStatus and synced are required.
  const missing: YCollabInput = {doc, layoutUpgrade: null, schemaVersion: 1};
  const ok = createYCollabConfig({
    doc,
    layoutUpgrade: null,
    onYStatus: null,
    schemaVersion: 1,
    synced: false,
  });
  expect([missing, ok].length).toBe(2);
});

test('the yStatus signal carries the cause, frozen included, as onYStatus does', async () => {
  // A peer with schema version 5 wrote the document.
  const doc = createYDoc();
  const newer = build(doc, {
    doc,
    onYStatus: null,
    schemaVersion: 5,
    synced: true,
  });
  await flush();
  newer.update(
    () => {
      $getRoot().append($createParagraphNode().append($createTextNode('v5')));
    },
    {discrete: true},
  );
  await flush();
  const copy = createYDoc(Y.encodeStateAsUpdate(doc));
  const seen: YStatus[] = [];
  const editor = build(copy, {
    doc: copy,
    onYStatus: (status: YStatus) => seen.push(status),
    schemaVersion: 1,
    synced: true,
  });
  await flush();
  const {collab, yStatus} = getExtensionDependencyFromEditor(
    editor,
    YCollabExtension,
  ).output;
  const readOnly = {
    cause: {code: 'schema-newer', schemaVersion: 5},
    kind: 'readonly',
  };
  expect(yStatus.value).toEqual(readOnly);
  expect(seen.at(-1)).toEqual(readOnly);
  // Freezing a binding that is read only already: the binding's own status
  // does not change, the cause does, and both channels say so.
  collab.freeze();
  await flush();
  const frozen = {cause: {code: 'frozen'}, kind: 'readonly'};
  expect(yStatus.value).toEqual(frozen);
  expect(seen.at(-1)).toEqual(frozen);
  editor.dispose();
  newer.dispose();
});

test('the headless config needs onWarn: a handler, or null (JavaScript callers throw)', () => {
  const $build = () => {
    $getRoot().append($createParagraphNode().append($createTextNode('x')));
  };
  expect(() =>
    seedYState({nodes: NODES, schemaVersion: 1} as never, $build),
  ).toThrow(
    /the config needs onWarn .*null to log them outside production only/,
  );
  // @ts-expect-error -- onWarn is required.
  void (() => seedYState({nodes: NODES, schemaVersion: 1}, $build));
  const state = seedYState(
    {nodes: NODES, onWarn: null, schemaVersion: 1},
    $build,
  );
  expect(
    readYState(state, {nodes: NODES, onWarn: () => {}, schemaVersion: 1}, () =>
      $getRoot().getTextContent(),
    ),
  ).toBe('x');
});
