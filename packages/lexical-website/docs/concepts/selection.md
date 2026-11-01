# Selection

## Types of selection

Lexical's selection is part of the `EditorState`. This means that for every update, or change to the editor, the
selection always remains consistent with that of the `EditorState`'s node tree.

In Lexical, there are four types of selection possible:

- `RangeSelection`
- `NodeSelection`
- `TableSelection` (implemented in `@lexical/table`)
- `null`

It is possible, but not generally recommended, to implement your own selection types that implement `BaseSelection`.

### `RangeSelection`

This is the most common type of selection, and is a normalization of the browser's DOM Selection and Range APIs.
`RangeSelection` consists of three main properties:

- `anchor` representing a `RangeSelection` point
- `focus` representing a `RangeSelection` point
- `format` numeric bitwise flag, representing any active text formats

Both the `anchor` and `focus` points refer to an object that represents a specific part of the editor. The main properties of a `RangeSelection` point are:

- `key` representing the `NodeKey` of the selected Lexical node
- `offset` representing the position from within its selected Lexical node. For the `text` type this is the character, and for the `element` type this is the child index from within the `ElementNode`
- `type` representing either `element` or `text`.

### `NodeSelection`

NodeSelection represents a selection of multiple arbitrary nodes. For example, three images selected at the same time.

- `getNodes()` returns an array containing the selected LexicalNodes

### `TableSelection`

TableSelection represents a grid-like selection like tables. It stores the key of the parent node where the selection takes place and the start and end points.
`TableSelection` consists of three main properties:

- `tableKey` representing the parent node key where the selection takes place
- `anchor` representing a `TableSelection` point
- `focus` representing a `TableSelection` point

For example, a table where you select row = 1 col = 1 to row 2 col = 2 could be stored as follows:
- `tableKey = 2` table key
- `anchor = 4` table cell (key may vary)
- `focus = 10` table cell (key may vary)

Note that `anchor` and `focus` points work the same way as `RangeSelection`.

### `null`

This is for when the editor doesn't have any active selection. This is common for when the editor has been blurred or when selection
has moved to another editor on the page. This can also happen when trying to select non-editable components within the editor space.

## Working with selection

Selection can be found using the `$getSelection()` helper, exported from the `lexical` package. This function can be used within
an update, a read, or a command listener.

:::tip

To walk the document from a selection point — or to write a traversal that
handles empty nodes and collapsed selections correctly — see
[Node Traversals with NodeCaret](./traversals.md).
`$caretRangeFromSelection(selection)` converts a `RangeSelection` into the
caret range that traversal API works with, and
`$setSelectionFromCaretRange(range)` converts back.

:::

```js
import {$getSelection, SELECTION_CHANGE_COMMAND} from 'lexical';

editor.update(() => {
  const selection = $getSelection();
});

editorState.read(() => {
  const selection = $getSelection();
});

// SELECTION_CHANGE_COMMAND runs before reconciliation in the pending update.
editor.registerCommand(SELECTION_CHANGE_COMMAND, () => {
  const selection = $getSelection();
});
```

In some cases you might want to create a new type of selection and set the editor selection to
be that. This can only be done in update or command listeners.

```js
import {$setSelection, $createRangeSelection, $createNodeSelection} from 'lexical';

editor.update(() => {
  // Set a range selection
  const rangeSelection = $createRangeSelection();
  $setSelection(rangeSelection);

  // You can also indirectly create a range selection, by calling some of the selection
  // methods on Lexical nodes.
  const someNode = $getNodeByKey(someKey);

  // On element nodes, this will create a RangeSelection with type "element",
  // referencing an offset relating to the child within the element.
  // On text nodes, this will create a RangeSelection with type "text",
  // referencing the text character offset.
  someNode.select();
  someNode.selectPrevious();
  someNode.selectNext();

  // You can use this on any node.
  someNode.selectStart();
  someNode.selectEnd();

  // Set a node selection
  const nodeSelection = $createNodeSelection();
  // Add a node key to the selection.
  nodeSelection.add(someKey);
  $setSelection(nodeSelection);

  // You can also clear selection by setting it to `null`.
  $setSelection(null);
});
```

## Focus

You may notice that when you issue an `editor.update` or
`editor.dispatchCommand` then the editor can "steal focus" if there is
a selection and the editor is editable. This is because the Lexical
selection is reconciled to the DOM selection during reconciliation,
and the browser's focus follows its DOM selection.

If you want to make updates or dispatch commands to the editor without
changing the selection, can use the `SKIP_DOM_SELECTION_TAG` update tag
(added in v0.22.0):

```js
// Call this from an editor.update or command listener
$addUpdateTag(SKIP_DOM_SELECTION_TAG);
```

If you want to add this tag during processing of a `dispatchCommand`,
you can wrap it in an `editor.update`:

```js
// NOTE: If you are already in a command listener or editor.update,
//       do *not* nest a second editor.update! Nested updates have
//       confusing semantics (dispatchCommand will re-use the
//       current update without nesting)
editor.update(() => {
  $addUpdateTag(SKIP_DOM_SELECTION_TAG);
  editor.dispatchCommand(/* … */);
});
```

`SKIP_DOM_SELECTION_TAG` does not apply to the initial editor state setup
(the `$initialEditorState` property of the root extension, or
`initialConfig.editorState` with the legacy `LexicalComposer`). On first mount the editor still scrolls
to and focuses the initial selection. To prevent that, call
`$setSelection(null)` inside your initial state setup function:

```js
const editor = buildEditorFromExtensions({
  name: '[root]',
  // ...
  $initialEditorState: () => {
    // ... build your initial nodes ...
    $setSelection(null);
  },
});
```

If you have to support older versions of Lexical, you can mark the editor
as not editable during the update or dispatch.

```js
// NOTE: This code should be *outside* of your update or command listener, e.g.
//       directly in the DOM event listener
const prevEditable = editor.isEditable();
editor.setEditable(false);
editor.update(
  () => {
    // run your update code or editor.dispatchCommand in here
  }, {
    onUpdate: () => {
      editor.setEditable(prevEditable);
    },
  },
);
```

## Reading selection across a shadow boundary

If your plugin reads the DOM selection directly — through
`Selection.anchorNode`, `Selection.getRangeAt(0)`, or similar — and the
editor's `contentEditable` lives inside a `ShadowRoot`, the browser retargets
those reads to the shadow host. See
[Shadow DOM and iframes](./shadow-dom.md) for the shadow-aware helpers
(`getDOMSelectionPoints`, `getDOMSelectionRange`, etc.) that return the
un-retargeted boundary points; they fall through to the standard reads in the
plain light DOM, so there's nothing to do until you actually mount the editor
in a shadow tree.

### Selection change timing

`SELECTION_CHANGE_COMMAND` runs **before reconciliation**, in a writable update,
for native, programmatic, and non-range selection changes. `$getSelection()`
returns the pending selection; `$getPreviousSelection()` returns the selection
from the last committed state. A listener can normalize the selection or edit
nodes before that same update commits. Listeners that change the selection may
cause another notification before commit; they must converge.

This covers programmatic changes such as `node.select()`, which notify without
waiting for a DOM `selectionchange` event, and non-range selections such as
`NodeSelection` and `TableSelection`, as well as native range selections.

Selection listeners use the update's normal error handling. A throwing listener
reports through `onError` and can abort the entire pending update, including the
edit that triggered the notification and any other edits batched into that
commit, just like an explicit command dispatch inside that update. Because a
programmatic selection change also notifies, a listener error can abort content
edits made in the same update. Listener edits do not have a separate rollback
scope.

The DOM is not guaranteed to match the pending state, even for a `NodeSelection`.
New nodes may not have an element yet, and DOM ranges, layout, and focus may
still reflect the previous state. Schedule DOM-dependent work after the update
and read the reconciled state there:

```ts
editor.registerCommand(
  SELECTION_CHANGE_COMMAND,
  () => {
    $onUpdate(() => {
      editor.read('latest', () => {
        // Read $getSelection(), look up elements, or position floating UI here.
      });
    });
    return false;
  },
  COMMAND_PRIORITY_LOW,
);
```

Import `$onUpdate` and `COMMAND_PRIORITY_LOW` from `lexical`. Read selection and
nodes inside the callback rather than capturing mutable pending objects.
`registerUpdateListener` is another option for UI that must respond to every
commit, including content changes that do not change the selection. Updates
using `SKIP_DOM_SELECTION_TAG` still deliberately leave the browser selection
unsynchronized.

#### Update tags and local edits

The notification belongs to the pending update and inherits its tags. A listener
can inspect them with `$hasUpdateTag`. In particular, Yjs does not sync content
edits back to peers when the update is tagged `COLLABORATION_TAG` or
`HISTORIC_TAG`; history also treats `HISTORIC_TAG` as replaying an existing entry.
This applies to content edits made by selection listeners in those updates.

Listeners that only apply to local editing should skip those tagged updates. If
a remote change or undo must trigger an independent local content edit, schedule
it after the tagged commit with `$onUpdate`, then start a fresh `editor.update`:

```ts
const $applyLocalEdit = () => {
  // Read the current selection and nodes, then apply a convergent local edit.
};

editor.registerCommand(
  SELECTION_CHANGE_COMMAND,
  () => {
    if ($hasUpdateTag(COLLABORATION_TAG) || $hasUpdateTag(HISTORIC_TAG)) {
      $onUpdate(() => editor.update($applyLocalEdit));
    } else {
      $applyLocalEdit();
    }
    return false;
  },
  COMMAND_PRIORITY_LOW,
);
```

Import the tags and `$hasUpdateTag` from `lexical`. Re-read the state in the fresh
update; it has its own collaboration and undo behavior. Calling `editor.update`
directly inside the command listener queues a nested update that still belongs
to the same tagged commit.

Automatic range and cleared-selection notifications require a connected editor
root. Changes committed while those notifications are skipped advance the
selection baseline and are not replayed when the root reconnects. Non-range
selections continue to notify in unmounted and headless editors,
with the same pre-reconciliation timing. Native dirty-selection notifications
may fire even when the selection compares equal to the previous selection.
