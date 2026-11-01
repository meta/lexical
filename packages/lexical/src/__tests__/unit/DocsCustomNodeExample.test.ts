/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {$create, $getRoot} from 'lexical';
// Copied verbatim from `docs/concepts/nodes.mdx`, so that the example compiles
// against the real API and the claims the section makes about it are checked.
import {
  ElementNode,
  enumValue,
  type LexicalParseJSON,
  nodeSchema,
  numberValue,
  type SerializedElementNode,
  type SerializedPartial,
  type Spread,
  stringValue,
  withField,
} from 'lexical';
import {describe, expect, test} from 'vitest';

export type SerializedCalloutNode = Spread<
  {label: string; level: number; tone: 'info' | 'warning' | 'danger'},
  SerializedElementNode
>;

const calloutNodeSchema = nodeSchema<CalloutNode>()({
  // Each property *is* a field: exported by reading it, imported by assigning
  // it, with no method call on either side.
  label: withField(stringValue(), {field: '__label'}),
  level: withField(numberValue(1, {integer: true, max: 3, min: 1}), {
    field: '__level',
  }),
  tone: withField(enumValue(['info', 'warning', 'danger']), {field: '__tone'}),
});

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface CalloutNode {
  exportJSON(compact?: false): SerializedCalloutNode;
  exportJSON(compact: boolean): SerializedPartial<SerializedCalloutNode>;
  updateFromJSON(serializedNode: LexicalParseJSON<SerializedCalloutNode>): this;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class CalloutNode extends ElementNode {
  __label: string = '';
  __level: number = 1;
  __tone: 'info' | 'warning' | 'danger' = 'info';

  $config() {
    return this.config('callout', {
      extends: ElementNode,
      json: calloutNodeSchema,
    });
  }

  createDOM(): HTMLElement {
    return document.createElement('aside');
  }

  updateDOM(): false {
    return false;
  }
}

describe('the CalloutNode from docs/concepts/nodes.mdx', () => {
  test('does what the section claims it does', () => {
    const editor = buildEditorFromExtensions(
      defineExtension({name: '[doc-callout]', nodes: [CalloutNode]}),
    );
    editor.update(
      () => {
        const callout = $create(CalloutNode);
        $getRoot().clear().append(callout);
        // "level: 9 or level: "big" or a missing level all land on 1 here"
        callout.updateFromJSON({label: 'Note', level: 9, tone: 'warning'});
        expect(callout.exportJSON()).toMatchObject({
          label: 'Note',
          level: 1,
          tone: 'warning',
        });
        callout.updateFromJSON({level: 'big'} as never);
        expect(callout.exportJSON().level).toBe(1);
        callout.updateFromJSON({});
        expect(callout.exportJSON().level).toBe(1);
        // …and an in-domain value is kept.
        callout.updateFromJSON({level: 3});
        expect(callout.exportJSON().level).toBe(3);
        // An out-of-domain enum falls back to the first value.
        callout.updateFromJSON({tone: 'banana'} as never);
        expect(callout.exportJSON().tone).toBe('info');
      },
      {discrete: true},
    );
    editor.dispose();
  });
});
