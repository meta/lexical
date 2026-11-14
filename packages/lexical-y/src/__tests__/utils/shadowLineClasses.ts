/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Line classes (`children: 'inline'`) that are shadow roots other than
// QuoteNode's per-instance flat `shadowRoot` state: layout 5 stores them as
// lines, as layout 4 did, and the 4to5 step leaves them as they are.

import {
  $getState,
  createState,
  ElementNode,
  type Klass,
  type LexicalNode,
} from 'lexical';

import {NODES} from './harness';

/** A line class whose every instance is a shadow root (a class-level flag). */
export class AlwaysShadowLineNode extends ElementNode {
  $config() {
    return this.config('test_always_shadow_line', {
      children: 'inline',
      extends: ElementNode,
    });
  }
  isShadowRoot(): boolean {
    return true;
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM(): false {
    return false;
  }
}

/** A `shadowRoot` flag kept in a NodeState that is not flat. */
export const calloutShadowRoot = createState('shadowRoot', {
  parse: v => v === true,
});

/** A line class whose shadow root flag is a NodeState that is not flat. */
export class CalloutNode extends ElementNode {
  $config() {
    return this.config('test_callout', {
      children: 'inline',
      extends: ElementNode,
      stateConfigs: [{stateConfig: calloutShadowRoot}],
    });
  }
  isShadowRoot(): boolean {
    return $getState(this, calloutShadowRoot);
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM(): false {
    return false;
  }
}

export const SHADOW_LINE_NODES: Klass<LexicalNode>[] = [
  ...NODES,
  AlwaysShadowLineNode,
  CalloutNode,
];
