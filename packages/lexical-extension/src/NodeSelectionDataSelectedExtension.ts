/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import invariant from '@lexical/internal/invariant';
import {
  $getSelection,
  $isNodeSelection,
  defineExtension,
  type EditorState,
  getRegisteredSubtypeMap,
  type Klass,
  type LexicalNode,
  type NodeKey,
  safeCast,
  shallowMergeConfig,
} from 'lexical';

import {getKnownTypesAndNodes} from './config';

export interface NodeSelectionDataSelectedConfig {
  /**
   * The node types whose host DOM should reflect their {@link NodeSelection}
   * membership. Pass the node classes (e.g. `[CardNode, FigureNode]`).
   * Registered subclasses of these classes are matched too, resolved to their
   * own {@link LexicalNode.getType} during init (before the editor is created)
   * so the update listener never needs a runtime `instanceof`.
   */
  nodes: Klass<LexicalNode>[];
  /**
   * The attribute toggled on the matched node's host DOM while it is part of
   * a `NodeSelection`. Defaults to `'data-selected'`. The value is always
   * `'true'`; the attribute is removed when the node is no longer selected.
   */
  attribute: string;
}

/**
 * @experimental
 *
 * Mirrors {@link NodeSelection} membership onto the host DOM as an attribute
 * so CSS can render a selection outline for `ElementNode` hosts, which have
 * no `decorate()` render path of their own. Configure it per node type:
 *
 * ```ts
 * configExtension(NodeSelectionDataSelectedExtension, {nodes: [CardNode]})
 * ```
 *
 * The matched host needs a corresponding CSS rule, e.g.
 * `.lexical-card-node[data-selected='true'] { outline: ... }`.
 */
export const NodeSelectionDataSelectedExtension = defineExtension({
  config: safeCast<NodeSelectionDataSelectedConfig>({
    attribute: 'data-selected',
    nodes: [],
  }),
  // Expand the configured classes to the types of every registered subclass,
  // so a subclass instance still matches without a runtime `instanceof`. This
  // needs the editor's node list, which is only available before creation.
  init(editorConfig, config) {
    const matchTypes = new Set<string>();
    const subtypeMap = getRegisteredSubtypeMap(
      getKnownTypesAndNodes(editorConfig).nodes,
    );
    for (const klass of config.nodes) {
      const type = klass.getType();
      const subtypes = subtypeMap.get(type);
      invariant(
        subtypes !== undefined,
        'Node class %s with type %s not registered in editor',
        klass.name,
        type,
      );
      matchTypes.add(type);
      for (const subtype of subtypes) {
        matchTypes.add(subtype);
      }
    }
    return {matchTypes};
  },
  // Each consuming extension contributes its own node type through a separate
  // `configExtension` call, but they all resolve to this single named
  // extension. The default shallow merge would let the last `nodes` array win
  // and silently drop every earlier type, so concatenate them instead.
  mergeConfig(config, partial) {
    return shallowMergeConfig(config, {
      ...partial,
      ...(partial.nodes && {nodes: [...config.nodes, ...partial.nodes]}),
    });
  },
  name: '@lexical/extension/NodeSelectionDataSelected',
  register(editor, config, state) {
    const {attribute} = config;
    const {matchTypes} = state.getInitResult();
    // key -> host DOM the attribute was set on, so the disposer can clear
    // still-mounted DOM even after the editor's key->DOM map is reset.
    const marked = new Map<NodeKey, HTMLElement>();
    const syncFromEditorState = (editorState: EditorState) => {
      const nextKeys = new Set<NodeKey>();
      editorState.read(() => {
        const selection = $getSelection();
        if ($isNodeSelection(selection)) {
          for (const node of selection.getNodes()) {
            if (matchTypes.has(node.getType())) {
              nextKeys.add(node.getKey());
            }
          }
        }
      });
      for (const [key, dom] of marked) {
        if (!nextKeys.has(key)) {
          dom.removeAttribute(attribute);
          marked.delete(key);
        }
      }
      for (const key of nextKeys) {
        const dom = editor.getElementByKey(key);
        if (dom !== null) {
          dom.setAttribute(attribute, 'true');
          marked.set(key, dom);
        }
      }
    };
    // A NodeSelection already committed when this registers (e.g. the
    // extension is added to a live editor) must be mirrored immediately,
    // not only on the next update.
    syncFromEditorState(editor.getEditorState());
    const removeUpdateListener = editor.registerUpdateListener(
      ({editorState}) => syncFromEditorState(editorState),
    );
    return () => {
      removeUpdateListener();
      for (const dom of marked.values()) {
        dom.removeAttribute(attribute);
      }
      marked.clear();
    };
  },
});
