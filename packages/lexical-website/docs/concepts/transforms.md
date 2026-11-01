

# Node Transforms

Transforms are the most efficient mechanism to respond to changes to the EditorState.

For example:
User types a character and you want to color the word blue if the word is now equal to "congrats".
We programmatically add an `@Mention` to the editor, the `@Mention` is immediately next to another `@Mention` (`@Mention@Mention`). Since we believe this makes mentions hard to read, we want to destroy/replace both mentions and render them as plain TextNode's instead.

```js
const removeTransform = editor.registerNodeTransform(TextNode, (textNode) => {
  if (textNode.getTextContent() === 'blue') {
    textNode.setTextContent('green');
  }
});
```

## Syntax

```typescript
editor.registerNodeTransform<T extends LexicalNode>(klass: Klass<T>, listener: Transform<T>): () => void
```

## Lifecycle

Transforms are executed sequentially before changes are propagated to the DOM and multiple transforms still lead to a single DOM reconciliation (the most expensive operation in Lexical's lifecycle).

```mermaid
flowchart LR
  accTitle: Transforms lifecycle
  accDescr: A keyboard event leads to an update function. Its changes mark nodes dirty, and the transforms registered for those nodes run one after another. If a transform changed more nodes, the transforms for those nodes run again. When nothing is left dirty, the DOM is reconciled once and the update listeners run.
  event{{"Keyboard event"}} --> update["Update function"]
  update --> t1["transform1"]
  t1 --> t2["transform2"]
  t2 --> dirty{"Nodes still dirty?"}
  dirty -->|"yes"| t1
  dirty -->|"no"| reconcile["DOM reconciled once"]
  reconcile --> listeners["Update listeners"]
```

:::caution Beware!

While it is possible to achieve the same or very similar result through an [update listener](listeners.md#registerupdatelistener) followed by an update, this is highly discouraged as it triggers an additional render (the most expensive lifecycle operation).

Additionally, each cycle creates a brand new `EditorState` object which can interfere with features like undo/redo (`HistoryExtension`) if not handled correctly.

```js
editor.registerUpdateListener(() => {
  editor.update(() => {
    // Don't do this
  });
});
```

:::

### Dirty Nodes

*Dirty Leaves* (any LexicalNode that is not an ElementNode) and *Dirty Elements*
are tracked separately to support the transform heuristic.

Internally, there are two states for dirty nodes:
* Intentionally Dirty nodes (leaves or elements) had `node.getWritable()` or
  `node.markDirty()` (an alias) called on them. Maintaining the
  tree-of-doubly-linked-lists structure of a lexical document requires that
  this Intentionally Dirty state will propagate to immediate siblings and in
  some cases the parent node.
* Unintentionally Dirty Element nodes are an ancestor of a
  dirty node that were not explicitly marked as Intentionally Dirty
  Only elements can be Unintentionally Dirty, because
  leaves by definition can not have children.

The reconciler works by starting at the RootNode (which is the ancestor
of any attached node, and thus always dirty whenever any attached node
is dirty). Intentionally Dirty nodes have their createDOM and/or updateDOM
called. Dirty Elements reconcile all of their children. Thus, reconciliation
stops at the highest node in a subtree that has no dirty nodes (unless it
is running with a flag to do a full reconciliation which considers all
nodes as Intentionally Dirty).

:::info

The transform heuristic depends on these internal implementation details to
find a fixed point where no more transforms are required.

:::

### Transform heuristic

1. We transform leaves first. If transforms generate additional dirty nodes we repeat `step 1`. The reasoning behind this is that marking a leaf as dirty marks all its parent elements as dirty too.
2. We transform elements.
    - If element transforms generate additional dirty nodes we repeat `step 1`.
    - If element transforms only generate additional dirty elements we only repeat `step 2`.

A node will be marked as dirty on any (or most) modifications done to it, its children, or siblings in certain cases.

## Preconditions

Preconditions are fundamental for transforms to prevent them from running multiple times and ultimately causing an infinite loop.

Transforms are designed to run when nodes have been modified (aka Intentionally Dirty). For the most part, transforms only need to run once after the update but the sequential nature of transforms makes it possible to have order bias. Hence, transforms are run over and over until this particular type of Node is no longer marked as intentionally dirty by any of the transforms.

Hence, we have to make sure that the transforms do not mark the node dirty unnecessarily.

```js
// When a TextNode changes (marked as dirty) make it bold
editor.registerNodeTransform(TextNode, textNode => {
  // Important: Check current format state
  if (!textNode.hasFormat('bold')) {
    textNode.toggleFormat('bold');
  }
});
```

But oftentimes, the order is not important. The below would always end up in the result of the two transforms:

```js
// Extension 1
editor.registerNodeTransform(TextNode, textNode => {
  // This transform runs twice but does nothing the first time because it doesn't meet the preconditions
  if (textNode.getTextContent() === 'modified') {
    textNode.setTextContent('re-modified');
  }
})
// Extension 2
editor.registerNodeTransform(TextNode, textNode => {
  // This transform runs only once
  if (textNode.getTextContent() === 'original') {
    textNode.setTextContent('modified');
  }
})
// App
editor.registerUpdateListener(({editorState}) => {
  const text = editorState.read(() => $getRoot().getTextContent());
  // text === 're-modified'
});
```

:::info

The transform heuristic considers `RootNode` to be Intentionally Dirty whenever
any node is dirty, and it ensures that this transform is applied last after all
other transforms. In this way, you can consider it a "pre-update" listener,
which occurs before any DOM reconciliation has happened. As with any other
transform, it may get called multiple times in a given update (especially if
your RootNode transform makes any node dirty).

:::

## Transforms on parent nodes

Transforms are very specific to a type of node. This applies to both the declaration (`registerNodeTransform(ImageNode)`) and the times it triggers during an update cycle.

```js
// Won't trigger
editor.registerNodeTransform(ParagraphNode, () => {});
// Will trigger as TextNode was marked dirty
editor.registerNodeTransform(TextNode, () => {});
editor.update(() => {
  const textNode = $getNodeByKey('3');
  textNode.setTextContent('foo');
});
```

While the marked dirty rule is always true, there are some cases when it's not immediately obvious and/or we force nearby nodes to become dirty for the sake of easier transform logic:
You add a node to an ElementNode, the ElementNode and the newly added children are marked dirty, also its new immediate siblings
You remove a node, its parent is marked dirty, also the node's immediate siblings prior to being removed
You move a node via `replace`, rules 2 and 1 are applied.

```js
editor.registerNodeTransform(ParagraphNode, paragraph => {
 // Triggers
});
editor.update(() => {
  const paragraph = $getRoot().getFirstChild();
  paragraph.append($createTextNode('foo'));
});
```

## registerLexicalTextEntity

It is common to have certain nodes that are created/destroyed based on their text content and siblings. For example, `#lexical` is a valid hashtag whereas `#!lexical` is not.

This is a perfectly valid case for transforms but we have gone ahead and already built a utility transform wrapper for you for this specific case:

```typescript
registerLexicalTextEntity<T extends TextNode>(
  editor: LexicalEditor,
  getMatch: (text: string) => null | EntityMatch,
  targetNode: Klass<T>,
  createNode: (textNode: TextNode) => T,
): Array<() => void>;
```

## Examples

1. [Emojis](https://github.com/meta/lexical/blob/main/packages/lexical-playground/src/plugins/EmojisExtension/index.ts)
2. [AutoLink](https://github.com/meta/lexical/blob/main/packages/lexical-playground/src/plugins/AutoLinkExtension/index.ts)
3. [HashtagExtension](https://github.com/meta/lexical/blob/main/packages/lexical-hashtag/src/LexicalHashtagExtension.ts)
