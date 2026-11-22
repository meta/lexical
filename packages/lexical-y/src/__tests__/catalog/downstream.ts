/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Stand-ins for node shapes that apps built on Lexical register, so the
// catalog covers shapes no `@lexical/*` package or the playground has:
//
// - a rich document editor's blocks: an image block decorator whose fields
//   are NodeState, a generic component (a block decorator with undeclared
//   named slots, each holding a shadow root of blocks that cannot be empty),
//   inline atoms (a citation whose text content comes from its state, a
//   field, a mention), and a column layout of shadow roots;
// - a note editor's shapes are the stock nodes (rich text, lists with check
//   lists, code, links, tables without merged cells), which the catalog
//   covers through the packages' own classes.

import {
  $create,
  $getState,
  $setSlot,
  $setState,
  createState,
  DecoratorNode,
  ElementNode,
  type LexicalNode,
} from 'lexical';

type JsonObject = Record<string, unknown>;

const stringState = (key: string) =>
  createState(key, {
    parse: (value): string => (typeof value === 'string' ? value : ''),
  });
const objectState = (key: string) =>
  createState(key, {
    isEqual: (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b),
    parse: (value): JsonObject =>
      value != null && typeof value === 'object' && !Array.isArray(value)
        ? (value as JsonObject)
        : {},
  });

const srcState = stringState('src');
const altState = stringState('alt');
const widthState = createState('width', {
  parse: (value): number | null =>
    typeof value === 'number' && value > 0 ? value : null,
});

function dom(tag: string): HTMLElement {
  return document.createElement(tag);
}

/** An image block whose fields are NodeState. */
export class DownstreamImageNode extends DecoratorNode<null> {
  $config() {
    return this.config('catalog_downstream_image', {
      extends: DecoratorNode,
      stateConfigs: [
        {stateConfig: srcState},
        {stateConfig: altState},
        {stateConfig: widthState},
      ],
    });
  }
  createDOM(): HTMLElement {
    return dom('div');
  }
  updateDOM(): false {
    return false;
  }
  isInline(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
}

const kindState = stringState('kind');
const propsState = objectState('props');

/** The shadow root that fills one named slot of a component. */
export class DownstreamComponentSlotNode extends ElementNode {
  $config() {
    return this.config('catalog_downstream_component_slot', {
      extends: ElementNode,
    });
  }
  createDOM(): HTMLElement {
    return dom('div');
  }
  updateDOM(): false {
    return false;
  }
  isShadowRoot(): true {
    return true;
  }
  canBeEmpty(): false {
    return false;
  }
}

/**
 * A generic component: a block decorator with free-form (undeclared) named
 * slots of rich content, and its kind and props as NodeState.
 */
export class DownstreamComponentNode extends DecoratorNode<null> {
  $config() {
    return this.config('catalog_downstream_component', {
      extends: DecoratorNode,
      stateConfigs: [{stateConfig: kindState}, {stateConfig: propsState}],
    });
  }
  createDOM(): HTMLElement {
    return dom('div');
  }
  updateDOM(): false {
    return false;
  }
  isInline(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
}

const labelPropsState = objectState('props');

/**
 * An inline citation atom: keyboard selectable, its text content read from
 * its state.
 */
export class DownstreamCitationNode extends DecoratorNode<null> {
  $config() {
    return this.config('catalog_downstream_citation', {
      extends: DecoratorNode,
      stateConfigs: [{stateConfig: kindState}, {stateConfig: labelPropsState}],
    });
  }
  createDOM(): HTMLElement {
    return dom('span');
  }
  updateDOM(): false {
    return false;
  }
  isInline(): true {
    return true;
  }
  isKeyboardSelectable(): true {
    return true;
  }
  getTextContent(): string {
    const props = $getState(this, labelPropsState) as JsonObject;
    const label = props.label;
    return typeof label === 'string' ? label : '';
  }
  decorate(): null {
    return null;
  }
}

const nameState = stringState('name');

/** An inline atom without text (a field or a mention chip). */
export class DownstreamAtomNode extends DecoratorNode<null> {
  $config() {
    return this.config('catalog_downstream_atom', {
      extends: DecoratorNode,
      stateConfigs: [{stateConfig: nameState}],
    });
  }
  createDOM(): HTMLElement {
    return dom('span');
  }
  updateDOM(): false {
    return false;
  }
  isInline(): true {
    return true;
  }
  decorate(): null {
    return null;
  }
}

/** A layout of column shadow roots; only the layout is a block. */
export class DownstreamColumnsNode extends ElementNode {
  $config() {
    return this.config('catalog_downstream_columns', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    return dom('div');
  }
  updateDOM(): false {
    return false;
  }
  canBeEmpty(): false {
    return false;
  }
}

/** One column of a layout. */
export class DownstreamColumnNode extends ElementNode {
  $config() {
    return this.config('catalog_downstream_column', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    return dom('div');
  }
  updateDOM(): false {
    return false;
  }
  isShadowRoot(): true {
    return true;
  }
  canBeEmpty(): false {
    return false;
  }
}

export const DOWNSTREAM_NODES = [
  DownstreamImageNode,
  DownstreamComponentNode,
  DownstreamComponentSlotNode,
  DownstreamCitationNode,
  DownstreamAtomNode,
  DownstreamColumnsNode,
  DownstreamColumnNode,
];

export function $createDownstreamImage(src: string, alt: string) {
  const node = $create(DownstreamImageNode);
  $setState(node, srcState, src);
  $setState(node, altState, alt);
  $setState(node, widthState, 320);
  return node;
}

/** A component with a slot per entry of `slots`, each holding its blocks. */
export function $createDownstreamComponent(
  kind: string,
  slots: Record<string, LexicalNode[]>,
) {
  const node = $create(DownstreamComponentNode);
  $setState(node, kindState, kind);
  $setState(node, propsState, {tone: 'info'});
  for (const name of Object.keys(slots)) {
    $setSlot(
      node,
      name,
      $create(DownstreamComponentSlotNode).append(...slots[name]),
    );
  }
  return node;
}

export function $createDownstreamCitation(label: string) {
  const node = $create(DownstreamCitationNode);
  $setState(node, kindState, 'source');
  $setState(node, labelPropsState, {label});
  return node;
}

export function $createDownstreamAtom(name: string) {
  const node = $create(DownstreamAtomNode);
  $setState(node, nameState, name);
  return node;
}

export function $createDownstreamColumns(columns: LexicalNode[][]) {
  return $create(DownstreamColumnsNode).append(
    ...columns.map(blocks => $create(DownstreamColumnNode).append(...blocks)),
  );
}
