/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {EditorConfig} from '../LexicalEditor';
import type {LexicalNode, NodeKey} from '../LexicalNode';

import invariant from '@lexical/internal/invariant';

import {IS_UNMERGEABLE} from '../LexicalConstants';
import {GENERATED_TAB} from '../LexicalGeneratedJSON';
import {
  enumValue,
  nodeSchema,
  numberValue,
  stringValue,
  withAccessors,
} from '../LexicalSchema';
import {$applyNodeReplacement, getCachedClassNameArray} from '../LexicalUtils';
import {
  type SerializedTextNode,
  type TextDetailType,
  type TextModeType,
  TextNode,
} from './LexicalTextNode';

export type SerializedTabNode = SerializedTextNode;

// A tab's content, detail and mode are fixed rather than stored:
// setTextContent normalizes any input to '\t', and setDetail/setMode reject
// anything but IS_UNMERGEABLE/'normal'. They are therefore derived on import —
// declaring that (rather than relying on defaults) both keeps a hand-authored
// or foreign `{detail: 0}` / `{mode: 'token'}` from reaching a setter that
// throws, and lets the compact form omit them.
const tabNodeSchema = nodeSchema<TabNode>()({
  // Read straight off the inherited fields — mode through the `getterTable`,
  // since it is stored as a bitmask. All three are export-only: the values are
  // fixed for a tab, so they are derived on import rather than applied.
  detail: withAccessors(numberValue(IS_UNMERGEABLE), {
    getter: {field: '__detail'},
    setter: null,
  }),
  mode: withAccessors(enumValue(['normal']), {
    getter: {
      field: '__mode',
      // Only the mode a tab can hold, rather than TextNode's whole table: that
      // one also maps the token and segmented bits, which this schema does not
      // serialize, and a `getterTable`'s values are held to the schema's domain.
      getterTable: {0: 'normal'},
    },
    setter: null,
  }),
  text: withAccessors(stringValue('\t'), {
    getter: {field: '__text', method: 'getTextContent'},
    setter: null,
  }),
});

/** @noInheritDoc */
export class TabNode extends TextNode {
  $config() {
    return this.config('tab', {
      extends: TextNode,
      generated: GENERATED_TAB,
      json: tabNodeSchema,
    });
  }

  // `key` carries an explicit `undefined` default (rather than the usual `?`)
  // so the constructor reports zero required arguments, which lets `$config`
  // synthesize the static `clone` by invoking the no-argument constructor.
  constructor(key: NodeKey | undefined = undefined) {
    super('\t', key);
    this.__detail = IS_UNMERGEABLE;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    const classNames = getCachedClassNameArray(config.theme, 'tab');

    if (classNames !== undefined) {
      const domClassList = dom.classList;
      domClassList.add(...classNames);
    }
    return dom;
  }

  /**
   * Always normalizes the stored content to `'\t'` regardless of input — see
   * comment below for the rationale.
   */
  setTextContent(_text: string): this {
    // The stored content is canonical regardless of input. Safari's
    // MutationObserver can deliver mid-IME-composition writes onto the
    // TabNode's `\t` text node (verified with Korean), and `flushMutations`
    // then calls this with the in-flight composition payload; throwing here
    // cascaded through `onError` and froze the editor (#8596). The dropped
    // check was guarding caller assumptions, not stored state — the
    // reconciler renders the canonical content on the next update.
    return super.setTextContent('\t');
  }

  spliceText(
    offset: number,
    delCount: number,
    newText: string,
    moveSelection?: boolean,
  ): TextNode {
    invariant(
      (newText === '' && delCount === 0) ||
        (newText === '\t' && delCount === 1),
      'TabNode does not support spliceText',
    );
    return this;
  }

  setDetail(detail: TextDetailType | number): this {
    invariant(detail === IS_UNMERGEABLE, 'TabNode does not support setDetail');
    return this;
  }

  setMode(type: TextModeType): this {
    invariant(type === 'normal', 'TabNode does not support setMode');
    return this;
  }

  canInsertTextBefore(): boolean {
    return false;
  }

  canInsertTextAfter(): boolean {
    return false;
  }
}

/** Creates a TabNode representing a horizontal tab character. */
export function $createTabNode(): TabNode {
  return $applyNodeReplacement(new TabNode());
}

/** Returns true if the given node is a TabNode. */
export function $isTabNode(
  node: LexicalNode | null | undefined,
): node is TabNode {
  return node instanceof TabNode;
}
