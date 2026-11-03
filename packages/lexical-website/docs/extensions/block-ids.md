# Block IDs

:::caution Experimental

`BlockIdExtension` and `BlockIdHTMLExtension` are experimental. Their API may
change in a minor release.

:::

`BlockIdExtension` (from `@lexical/extension`) gives blocks stable, unique
ids, so that code outside the editor can address a block by id: in a
headless process editing stored JSON, in a single-user editor, and across
editors that apply the same JSON. The main use case is an agent that reads a document as blocks
with ids and answers "replace `b7`" or "delete `b9`", which must find the
right block after the document was saved, reloaded or edited by others.

## Setup

```ts
import {BlockIdExtension, buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';

const editor = buildEditorFromExtensions({
  dependencies: [RichTextExtension, BlockIdExtension],
  name: 'my-editor',
});
```

An id is [NodeState](/docs/concepts/node-state) under the key `blockId`
(`blockIdState`), so it is part of the node's JSON
(`"$": {"blockId": "V1StGXR8_Z5jdHi6B-myT"}`), survives clones, undo and redo
and the Lexical clipboard, and is carried by anything that copies
NodeState. Editors that do not register the extension are not affected.

Using block ids with collaboration: see
[Collaboration > Block IDs](/docs/collaboration/block-ids).

## Addressing blocks

`$getBlockId(node)` returns a node's id, and `$getBlockById(id)` finds a
block through an index (while the extension is enabled; while it is
disabled, by a scan of the document). A block created or replaced earlier
in the same update is found once that update has committed.

To let an agent edit a document, give it each block's id and content, then
apply its operations by id, each in its own update:

```ts
import {$getBlockById, $getBlockId} from '@lexical/extension';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
} from 'lexical';

// 1. What the agent reads (here, the top-level blocks).
const blocks = editor.read(() =>
  $getRoot()
    .getChildren()
    .map(node => ({id: $getBlockId(node), text: node.getTextContent()})),
);

// 2. What the agent answers, e.g.
//    [{op: 'replace', id: 'b7', text: 'New text'},
//     {op: 'insertAfter', id: 'b7', text: 'Another paragraph'},
//     {op: 'delete', id: 'b9'}]
for (const op of ops) {
  editor.update(
    () => {
      const block = $getBlockById(op.id);
      if (block === null) {
        return; // Deleted meanwhile, or a mistyped id: tell the agent.
      }
      if (op.op === 'delete') {
        block.remove();
      } else {
        const node = $createParagraphNode().append($createTextNode(op.text));
        if (op.op === 'replace') {
          block.replace(node); // Keeps id b7.
          // A selection that ended inside the replaced block lost that end:
          // move it to the new block.
          const selection = $getSelection();
          if (
            $isRangeSelection(selection) &&
            [selection.anchor, selection.focus].some(
              point => !point.getNode().isAttached(),
            )
          ) {
            node.selectEnd();
          }
        } else {
          block.insertAfter(node); // Gets a fresh id.
        }
      }
    },
    {discrete: true},
  );
}
```

One update per operation matters. Within one update, a block that an
earlier operation replaced is not found until the update commits, and a new
block inserted where an earlier operation removed one takes the removed
block's id, as `replace` does. `replace` with a node that has no id keeps
the replaced block's id, so the agent can keep referring to `b7`. Whether typing that
another replica made concurrently in the replaced block survives depends on
how the replicas merge changes, not on this extension. With
[`@lexical/y`](/docs/collaboration/y), a replaced block is a delete and an
insert. In a line such as a paragraph, what a collaborator types at the
same time survives, with its own formatting, at the start of the new text
(typed at the end of the line, it can also stay at the end); formatting of
the replaced characters does not carry over. Replacing a block stored as a
node of its own, such as a table, deletes what was typed in it. Edit text in place instead (see
[Edits by block id](/docs/collaboration/y-server#edits-by-block-id)). To give a new block an id of your choosing, set
it before inserting it: `$setState(node, blockIdState, 'b7-intro')`. If
another block already has that id, that block keeps it and the new one gets
a fresh id.

### Headless

A server that stores Lexical JSON can assign ids to a document (or to the
blocks that lack one) in one synchronous load and save:

```ts
const pipeline = buildEditorFromExtensions({
  $initialEditorState: null,
  dependencies: [RichTextExtension, BlockIdExtension],
  name: 'docs-pipeline',
});

pipeline.setEditorState(pipeline.parseEditorState(storedJSON));
const withIds = JSON.stringify(pipeline.getEditorState().toJSON());
```

Register the same nodes as the editors that wrote the document. Running it
again changes nothing, and the ids it assigns are
[derived from the document](#documents-stored-without-ids), so a server that
only reads gets the same ids without writing first.

## Showing blocks to a model

A whole id costs a language model about 14 tokens to read and to copy back.
To show blocks to a model, give it **handles** instead: short, opaque names,
almost always 4 characters long. `V1StGXR8_Z5jdHi6B-myT` is shown as `2bNo`,
which costs 3 to 4 tokens. A handle is the shortest prefix, at least 4
characters long, of a 64-bit hash of the block's id that no other block's
hash starts with, like a short git hash. The document keeps its ids; handles
are derived from them when they are read, so nothing is stored in the
document.

| | Tokens per block (o200k) |
| --- | --- |
| 21-character id | 14.4 on its own, 15.4 in an attribute or a JSON string |
| Handle | 2.9 on its own, 3.9 in an attribute or a JSON string |

(Measured over 20,000 random ids in 1,000-block documents, where almost
every handle is 4 characters long.)

The round trip has three steps: export handles (and keep them), let the
model answer with them, and resolve each one back to a block in the update
that applies the edit:

```ts
import {
  $getBlockHandle,
  $getBlockHandles,
  $resolveBlockHandle,
} from '@lexical/extension';
import {
  $createTextNode,
  $getRoot,
  $getSlotNames,
  $isElementNode,
  $isTextNode,
  type ElementNode,
  type LexicalNode,
  type TextNode,
} from 'lexical';

// 1. What the model reads, and the handles it is shown (id → handle).
const [blocks, shown] = editor.read(() => [
  $getRoot()
    .getChildren()
    .map(node => ({block: $getBlockHandle(node), text: node.getTextContent()})),
  $getBlockHandles(),
]);
// [{block: '2bNo', text: 'Q3 plan'}, {block: 'gTtF', text: 'Revenue grew 4%.'}]

// 2. What the model answers, e.g. {block: 'gTtF', text: 'Revenue grew 6%.'}

// 3. Applying it, in its own update: the handle names the block it named in
//    the read, if that block still exists now.
const feedback: string[] = [];
editor.update(
  () => {
    const result = $resolveBlockHandle(op.block, {read: shown});
    switch (result.status) {
      case 'found':
        if (!$setBlockText(result.node, op.text)) {
          feedback.push(
            `${op.block} holds line breaks or other blocks: edit its parts.`,
          );
        }
        break;
      case 'not-found':
        feedback.push(`No block ${result.handle}: it may have been deleted.`);
        break;
      case 'ambiguous':
        feedback.push(
          `${result.handle} names several blocks: use one of ${result.candidates.join(', ')}.`,
        );
        break;
      case 'invalid':
        feedback.push(
          result.reason === 'too-short'
            ? `${result.handle} is too short: block handles have at least 4 characters.`
            : `${result.handle} is not a block handle.`,
        );
        break;
    }
  },
  {discrete: true},
);

// Changes a block's text in place: only the characters that differ, in the
// block's own text nodes. block.replace(newBlock) would re-create the block,
// and what a collaborator types in it meanwhile would not stay where they
// typed it. Returns false, changing nothing, unless the block holds only
// simple text (no tabs, hashtags or other special text nodes), directly or
// in inline elements such as links: no line breaks, nested blocks, named
// slots or decorators, even ones without text. Text added at the edge of an
// inline element that takes no text there (a link) goes beside it, as typing
// does.
function $setBlockText(block: LexicalNode, text: string): boolean {
  if (!$isElementNode(block) || !$holdsOnlyText(block)) {
    return false;
  }
  const nodes = block.getAllTextNodes();
  const old = nodes.map(node => node.getTextContent()).join('');
  let start = 0;
  while (start < old.length && old[start] === text[start]) {
    start++;
  }
  let end = 0;
  while (
    end < old.length - start &&
    end < text.length - start &&
    old[old.length - 1 - end] === text[text.length - 1 - end]
  ) {
    end++;
  }
  const inserted = text.slice(start, text.length - end);
  const deleteEnd = old.length - end;
  let offset = 0;
  let done = false;
  for (const node of nodes) {
    const size = node.getTextContentSize();
    const from = Math.max(start - offset, 0);
    const to = Math.min(deleteEnd - offset, size);
    if (
      !done &&
      (start - offset < size ||
        (start - offset === size && start === deleteEnd))
    ) {
      // The node where the change starts (for an insert at a node boundary,
      // the node before it): delete and insert there.
      if (start === deleteEnd) {
        $insertText(node, from, inserted);
      } else {
        node.spliceText(from, to - from, inserted);
      }
      done = true;
    } else if (to > from) {
      node.spliceText(from, to - from, '');
    }
    offset += size;
  }
  if (!done && inserted !== '') {
    block.append($createTextNode(inserted));
  }
  return true;
}

function $holdsOnlyText(element: ElementNode): boolean {
  // Named slots hold blocks of their own (and count in getTextContent).
  return (
    $getSlotNames(element).length === 0 &&
    element
      .getChildren()
      .every(
        child =>
          ($isTextNode(child) && child.isSimpleText()) ||
          ($isElementNode(child) && child.isInline() && $holdsOnlyText(child)),
      )
  );
}

// Inserts text at `at` in `node`, or, at an edge of inline elements that
// take no text there (canInsertTextAfter or canInsertTextBefore is false, as
// for a link or a mark), beside the outermost of them.
function $insertText(node: TextNode, at: number, text: string): void {
  if (text === '') {
    return;
  }
  const atEnd = at === node.getTextContentSize();
  let outermost: ElementNode | null = null;
  for (
    let inner: LexicalNode = node, parent = node.getParent();
    $isElementNode(parent) && parent.isInline();
    inner = parent, parent = parent.getParent()
  ) {
    if (
      atEnd
        ? inner.getNextSibling() !== null
        : at !== 0 || inner.getPreviousSibling() !== null
    ) {
      break;
    }
    if (atEnd ? !parent.canInsertTextAfter() : !parent.canInsertTextBefore()) {
      outermost = parent;
    }
  }
  if (outermost === null) {
    node.spliceText(at, 0, text);
    return;
  }
  const beside = atEnd
    ? outermost.getNextSibling()
    : outermost.getPreviousSibling();
  if ($isTextNode(beside) && beside.isSimpleText()) {
    beside.spliceText(atEnd ? 0 : beside.getTextContentSize(), 0, text);
  } else if (atEnd) {
    outermost.insertAfter($createTextNode(text));
  } else {
    outermost.insertBefore($createTextNode(text));
  }
}
```

`$resolveBlockHandle` never throws for bad input, since a model's answer
cannot be trusted. With `read`, the handles the model was shown, a handle
names the block it named in that read: `found` while that block still
exists, `not-found` once it is deleted, even if a block added since now has
the same handle, and never `ambiguous` because of a block added since. Pass it whenever the document can change between the read and
the edit (with collaboration, always). The result says what to tell the
model:

| Status | Meaning | Tell the model |
| --- | --- | --- |
| `found` | `result.node` is the block | Nothing: apply the edit |
| `not-found` | The block was deleted since the read, or the handle names no block (a typo) | The block does not exist; send the current document if it needs one |
| `ambiguous` | It names several blocks: a handle shorter than the one shown (or, without `read`, a block added since has a handle that starts the same way) | Retry with one of `result.candidates` |
| `invalid` | `reason: 'too-short'`: fewer than 4 characters. `reason: 'malformed'`: not 1 to 64 characters of `A`–`Z`, `a`–`z`, `0`–`9`, `-`, `_` | Too short: handles have at least 4 characters. Malformed: it is not a handle |

A handle has 4 to 11 characters. A longer prefix of the same hash still finds
its block, so a handle read while another block's hash shared more of it
keeps working after that block is deleted. A string longer than 11
characters is taken as a whole id, so whole ids of 12 characters or more
(the default 21-character ids included) are accepted too; only handles are
typo-safe.

Because handles come from a hash, they are short and typo-safe whatever the
ids look like. Over 30 documents of 1,000 blocks each, one-character typos of
a handle (a character changed, dropped or added) named another block this
often, nearly always by being exactly that block's handle:

| Ids | Handle length (mean, max) | Typos that name another block |
| --- | --- | --- |
| Random, 21 characters (the default) | 4.0, 5 | 2.8 in 100,000 |
| UUIDv7, made milliseconds apart | 4.0, 4 | 2.6 in 100,000 |
| `@lexical/y` derived ids (one client, close clocks) | 4.0, 5 | 2.4 in 100,000 |

A sequential alias such as `b12` mistyped as `b13` names a real block every
time.

`$getBlockHandles()` returns every block's handle at once, keyed by id. Handles
are computed from the same blocks as `$getBlockById`: the identified blocks of
the last committed state, all at once and cached until a commit changes an
id, so reading the handle of each of 10,000 blocks takes a few milliseconds.
While the extension is disabled, they come from a scan of the last committed
state, kept until the next commit, so reading each block's handle costs
about the same either way.

### Handles and collaboration

Handles are computed from one state of the document and never stored, so
two replicas can show different handles for the same block while they have
different blocks; the ids underneath are the same. Resolve a handle against
the latest state, with the `read` it was shown in: a block deleted since
then is `not-found`, the intended failure. Report it to the model and let it
read the document again. Without `read`, a handle names whichever block it
names now: once its block is deleted, a block added since whose hash starts
the same way would take it.

With [`@lexical/y`](/docs/collaboration/y) on a server, an agent's edit is
checked on the stored state and applied there (see
[Edits by agents and tools](/docs/collaboration/y-server#edits-by-agents-and-tools)):
resolve the handle against the stored state, check that the block is still
where and what the model read (the whole block: its type, text, formats,
style, NodeState and children, not only its text, as the checking schema
exports them, so check with a schema that still declares every field stored
versions may hold), then apply the edit to
the stored state by id, storing it with a compare-and-set and starting over
on a lost race. Resolved in the read instead, a handle always finds its
block: the read still has it. With several ops, check them all first and
apply none when one fails.

```ts
import {
  $getBlockById,
  $getBlockHandles,
  $getBlockId,
  $resolveBlockHandle,
} from '@lexical/extension';
import {readYState} from '@lexical/y/headless';
import {$getRoot, $isElementNode} from 'lexical';

// BlockIdExtension is among config.extensions, as on the clients.
// `applyChecked` (the check, the edit, the compare-and-set and its retries)
// and `$blockAt` (where a block is and all it holds, as this schema exports
// it) are the server page's:
// see Edits by agents and tools, and Edits by block id.

// At the read: `seen` is the state the model reads; keep the handles it is
// shown with it, and each block it read as a whole.
const shown = readYState(seen, config, () => $getBlockHandles());
const read = new Map(
  readYState(seen, config, () =>
    $getRoot()
      .getChildren()
      .map(node => {
        const id = $getBlockId(node)!;
        return [id, $blockAt(id)];
      }),
  ),
);

// When the answer arrives: resolve the handle against the stored state, with
// the handles the model was shown, check the block, and apply the edit there
// by id, in place; or nothing.
let id = '';
const refused = await applyChecked(
  store,
  config,
  () => {
    const result = $resolveBlockHandle(op.block, {read: shown});
    if (result.status !== 'found') {
      return [result.status];
    }
    id = $getBlockId(result.node)!;
    if ($blockAt(id) !== read.get(id)) {
      return ['changed' as const];
    }
    return $isElementNode(result.node) && $holdsOnlyText(result.node)
      ? []
      : ['not just text' as const];
  },
  () =>
    $setBlockText($getBlockById(id)!, op.text)
      ? []
      : ['not just text' as const],
);
if (refused !== null) {
  // Tell the model, as in the table above ('changed': read it again).
}
```

### Handles in HTML

With [`BlockIdHTMLExtension`](#html), `handles: true` writes handles instead
of ids, in a `data-block-handle` attribute (`BLOCK_HANDLE_ATTRIBUTE`):

```ts
import {
  $getBlockHandles,
  BlockIdExtension,
  buildEditorFromExtensions,
} from '@lexical/extension';
import {$generateHtmlFromNodes} from '@lexical/html';
import {BlockIdHTMLExtension} from '@lexical/html/BlockIdHTMLExtension';
import {RichTextExtension} from '@lexical/rich-text';
import {configExtension} from 'lexical';

const editor = buildEditorFromExtensions({
  dependencies: [
    RichTextExtension,
    BlockIdExtension,
    configExtension(BlockIdHTMLExtension, {handles: true}),
  ],
  name: 'my-editor',
});
// The HTML the model reads, and the handles it is shown, in one read.
const [html, shown] = editor.read(() => [
  $generateHtmlFromNodes(editor),
  $getBlockHandles(),
]);
// <h2 data-block-handle="2bNo">…</h2><p data-block-handle="gTtF">…</p>
```

Resolve the model's answers with `$resolveBlockHandle(handle, {read: shown})`
and apply them in place, as above, so that a handle names the block the
model was shown.

Import reads only `data-block-id`, never `data-block-handle`, so a handle is
never mistaken for an id: HTML with handles that is pasted back gives its
blocks fresh ids. The setting applies to all HTML the editor exports, copied
HTML included (copying between Lexical editors still carries ids, in the
Lexical clipboard format).

## Which blocks get ids

By default (`$defaultIsIdentifiedBlock`): every child of the root (a
top-level list or table included), every nested block that holds text, and
every nested block decorator. A block holds text when its class declares
`children: 'inline'` (or a list that includes `'inline'`) in its
[node structure](/docs/serialization/#node-structure): list
items, and paragraphs, headings, quotes and code blocks inside table cells
or other containers. Nested wrappers get no id: nested lists, table rows and
cells, shadow roots, and nested elements whose class declares no
`children`. [Slots](/docs/concepts/named-slots) count as nested, like
shadow roots.

`$isIdentifiedBlock` changes the set. It is evaluated when a node is marked
dirty, so it should depend only on the node and its ancestors, and every
reader of a document stored without ids must use the same one, since
[positional ids](#id-format) follow from it:

```ts
import {
  $defaultIsIdentifiedBlock,
  $isRootChildBlock,
  BlockIdExtension,
} from '@lexical/extension';
import {$isTableCellNode} from '@lexical/table';
import {configExtension} from 'lexical';

// Top-level blocks only.
configExtension(BlockIdExtension, {$isIdentifiedBlock: $isRootChildBlock});

// The default, plus table cells.
configExtension(BlockIdExtension, {
  $isIdentifiedBlock: node =>
    $defaultIsIdentifiedBlock(node) || $isTableCellNode(node),
});
```

Ids are unique within one editor. A nested editor (an image caption, say) is
an editor of its own: give it its own `BlockIdExtension` if its blocks need
ids, and key them by the nested editor too. Two nested editors with the same
content stored without ids get the same positional ids.

## How ids follow edits

An identified block without an id gets one in the same update that creates
it, whether it was typed, pasted, or produced by `importJSON`, HTML or
Markdown import. Ids then follow the content the user sees:

| Edit | Result |
| --- | --- |
| Enter in the middle or at the end of a block | The block keeps its id; the new block after it gets a fresh one |
| Enter at the start of a block | The text moves into the new block below, and the id moves with it |
| Backspace at the start of a block (join) | The block that absorbs the content keeps its id |
| Paragraph to heading or quote, and back | The new block keeps the id of the block it replaced |
| Paragraph to list | The item keeps the paragraph's id; the list gets a fresh one |
| `node.replace(newNode)` with a node that has no id, or `$setSlot` replacing a slot value | The new node keeps the replaced node's id |
| Removing a block and inserting a block without an id where it sat, in one update | The same as `replace`: the new block keeps the removed block's id |
| Moving a block (drag and drop, `insertAfter` of an existing node) | The id moves with the block |
| Copy and paste, duplicate, import of copied content | The copy gets a fresh id unless no other block has the id |
| Cut and paste | The pasted block keeps the id |
| Undo and redo | Ids are restored exactly |

The same rules apply to nested blocks. `$copyNode` does not copy the id.

With [`NodeStructureExtension`](/docs/serialization/#node-structure), which
repairs the structure node classes declare in the same update as the change,
the rules apply to the structure the update ends with, in whichever order
the two extensions are listed:

- A block split around a block lifted out of it keeps its id on the first
  piece; the later pieces get fresh ids.
- A block lifted out of a block that it leaves empty takes that block's
  place, and its id if it has none, as with `replace`.
- Paragraphs joined into a block as lines leave that block its id.
- Equal adjacent lists merge into the first, which keeps its id; a new list
  without an id continues the list merged into it.

The same holds when `NodeStructureExtension` is enabled after the editor is
built (its `disabled` output turned off later, or `registerNodeStructure()`
called on a built editor), so that it repairs after this extension in each
transform pass, with one difference: a load is then named before the repairs
(see [Documents stored without ids](#documents-stored-without-ids)).

A block that stops being identified (a top-level list that indenting nests
into a list item, a table moved into a table cell) keeps its id in NodeState
but is not indexed, and gets it back when it is identified again. Such an
id is not reserved: if another block took it meanwhile (a copy of the
nested block pasted at the top level), that block keeps it, and the
returning block gets a fresh one.

### Uniqueness

When several identified blocks carry the same id, one keeps it and the
others get new ids: a block that had it before the update wins over a copy
(even one placed above it); among blocks that all had it (copies made
concurrently on different replicas), the earliest in document order wins, and the
others get ids [derived from it](#id-format); among blocks that all got it in
this update, one that took the content of the removed original wins (a copy
that a list merged the original into), else the first one created. A copy
that yields its id counts as a block without an id, so a copy of a list
pasted right above an equal list continues that list when the two merge.

## Documents stored without ids

A document stored before it had ids (written by an editor without the
extension, by a server, or converted from another format) gets **positional
ids** when it is loaded: derived from the document's content and each
block's place in it. Everyone who loads the same document derives the same
ids, so an agent can read ids without writing first, a person's first edit
keeps the ids the agent read, and editors that open the same document
independently assign the same ids. Two versions of a document get different
ids, so an id read from one version does not silently name a block of
another.

A load is a state set with `setEditorState`, the state present when the
extension is registered, the first content an editor gets (an initial state,
an import into a new headless editor, a first change applied with
`skipTransforms`), and an update applied with `skipTransforms` or tagged
`COLLABORATION_TAG` or `HISTORIC_TAG` that brings blocks without a valid id
or with a repeated id.
Everything else is an edit, and gets random ids. Positional ids are unique
within a document only: key a cross-document index by document too.

Positional ids are derived once the transforms of the load have settled,
from the document the load ends with, as [Id format](#id-format) describes.
A stored document that loading changes therefore gets ids that cannot be
computed from its stored JSON alone: adjacent text nodes that Lexical
merges, equal adjacent lists that `ListNode` merges, and anything
`NodeStructureExtension` repairs (a paragraph split around a quote stored
inside it, for example). Editors that load it with the same nodes, predicate
and normalization derive the same ids. Because the document key covers the
whole document, editors that normalize it differently derive different ids
for every block of such a document, not only for the blocks the
normalization changed: an editor with `NodeStructureExtension` and one
without it disagree on a document that `NodeStructureExtension` repairs
(they agree on lists, which `ListNode` merges in both). Use the same
extensions in every editor that reads such documents, or store them once
with their ids. Documents that loading does not change, including the
[test vector](#test-vector), are not affected.

With `NodeStructureExtension` enabled after the editor is built, the load is
named before its repairs: blocks that the repairs keep get the positional ids
of the document as it was before them, a list merged into another loses its
id, and blocks the repairs create get ids from the document the load ends
with.

## HTML

Ids are not part of HTML by default. Add `BlockIdHTMLExtension` (from
`@lexical/html/BlockIdHTMLExtension`) to the editor's dependencies to opt in:

- **Export:** every identified block's element gets a `data-block-id`
  attribute, in `$generateHtmlFromNodes` and in copied HTML. A list item
  that only wraps a nested list has no element of its own (the nested list
  is written inside the previous item's element), so its id goes on the
  nested list's element in `data-block-wrapper-id`
  (`BLOCK_WRAPPER_ID_ATTRIBUTE`), and import puts it back on the item that
  wraps that list. HTML a Lexical editor exports keeps every such id; in HTML
  another tool changed, extra elements between the nested list and its item
  can make the item get a new id instead. A block whose node exports no element at all (as the
  playground's page, of which only the content is written) keeps no id
  through HTML.
- **Import:** HTML imported through
  [`DOMImportExtension`](/docs/serialization/dom-import) (for example with
  `ClipboardDOMImportExtension`) reads `data-block-id` back onto the block
  the element produced, through the uniqueness rules. An invalid value is
  ignored, and the id is dropped from a block that is not identified once it
  is inserted (a table cell, a nested list). The legacy `importDOM` path
  does not read it.

Set `export: false` or `import: false` to use only one direction. Keep the
export off in editors whose HTML must be byte-for-byte deterministic
(snapshot comparisons, content hashing). `handles: true` (default `false`)
makes the export write handles in `data-block-handle` instead of ids, for
HTML shown to a model (see [Handles in HTML](#handles-in-html)); it has no
effect while `export` is off.

## Configuration

- `generateId`: makes a new id. The default, `generateBlockId`, makes 21
  base64url characters (126 random bits) with `crypto.getRandomValues`, and
  throws where that is missing (React Native without a polyfill). A
  replacement must return a valid id (see below) that stays unique across
  every editor that writes the document, since ids are made without
  coordination. A value that is invalid
  or already used in the editor is discarded and `generateId` is called
  again; 32 such values in a row throw. Tests can use a counter:
  ``generateId: () => `b${++n}` ``. Any id format gets short, typo-safe
  [handles](#showing-blocks-to-a-model), since handles hash the ids.
- `disabled`: stops assigning, repairing and indexing ids (also an output
  signal). Ids already in the document are kept, and `$getBlockById` scans
  the document. Enabling it again assigns and repairs ids in one update.
- `repairTransforms` (default `true`): blocks that an update applied with
  `skipTransforms`, or tagged `COLLABORATION_TAG` or `HISTORIC_TAG`, leaves
  without a valid id (or with a repeated one) are named by a follow-up
  update. By default it marks those blocks dirty, so every transform of the
  editor runs on them in it (`NodeStructureExtension` repairs their
  structure, for example). With `false` it sets their ids without running
  transforms, so it changes nothing else: for code that applies such updates
  and repairs what they bring in an update of its own. The ids are the same
  either way for blocks the transforms would not change.
  [`YCollabExtension`](/docs/collaboration/y) sets it to `false`, and the
  `@lexical/y` binding goes read only with `true` (an
  `UNSUPPORTED_CONFIG_WARNING`), because transforms run on what a remote
  change brought can derive different content on each client.
- **Valid ids.** An id is 1 to 64 characters of the base64url alphabet
  (`A`–`Z`, `a`–`z`, `0`–`9`, `-`, `_`), so it is safe in URLs, HTML
  attributes and JSON without escaping. Any such value under `$.blockId` is
  adopted as it is, so an app that stores its own ids there (UUIDs, nanoids,
  shorter ids) can switch to the exported `blockIdState`. Any other value
  (`"doc:12"`, a string with spaces) reads as no id: the block gets a new
  one, positional in a load and derived in a repair.

## Id format

Ids made by the default `generateId` are 21 characters of the base64url
alphabet, and so are positional and derived ids. Positional ids are part of
the stored format: every reader of a document stored without ids must derive
the same ones, whatever version of Lexical (or whatever language) it runs.

1. **The document.** Take the compact export of the root of the loaded
   state, `editorState.toJSON(true).root` (not the whole `toJSON(true)`
   object), after the transforms of the load have run. Remove every
   `blockId` from the nodes' NodeState (`$`), and a `$` that held nothing
   else.
2. **Canonical JSON.** Write it with ECMA-262 `JSON.stringify` semantics,
   without whitespace, after inserting every object's keys in ascending
   UTF-16 code unit order. That fixes every byte:
   - members: keys that are array indices (`"0"` to `"4294967294"`, without
     leading zeros) first, in ascending numeric order, then the other keys in
     ascending UTF-16 code unit order (`{"9":…,"10":…,"":…,"B":…,"a":…}`,
     not the order of a plain sort); members whose value is `undefined` are
     left out;
   - strings: `"` and `\` escaped with a backslash, `\b \f \n \r \t` for
     those controls, `\u00XX` (lowercase hexadecimal) for other code units
     below U+0020 and for lone surrogates, every other character as it is
     (no `\u` escapes for non-ASCII);
   - numbers: ECMAScript Number-to-String (`1` not `1.0`, `1.5`, `1e+21`,
     `0` for `-0`).
3. **The document key.** SHA-256 of the canonical JSON's UTF-8 bytes.
4. **The block's place.** Its index among the identified blocks with the
   same nearest identified ancestor (or the root), in document order, after
   that ancestor's place, joined by `.`. Document order visits a host's
   slot values before its children, in canonical slot order: the names its
   class declares in `$config().slots`, in that order, then the others in
   UTF-16 code unit order. A root child's place is its index (`"0"`, `"1"`,
   …); the second item of a list at index 3 is `"3.1"`, and so is the
   paragraph in the second cell of a one-row table at index 3. Blocks that
   keep a stored id count too.
5. **The id.** The first 21 characters of the unpadded base64url encoding of
   SHA-256(key ‖ UTF-8(place)). When the id is taken (by a stored id or an
   earlier place), the n-th retry appends `#n` to the place (`"3#1"`).

The k-th later holder (in document order, from 1) of a repeated id `id` gets
the first 21 characters of the unpadded base64url encoding of
SHA-256(UTF-8(`"dup"` + U+0000 + `id` + U+0000 + `k`)), `k` in decimal. When
that id is taken, the n-th retry appends `#n` to `k` (`"1#1"`). Repeated ids
are handled in UTF-16 code unit order of the ids.

The key comes from the nodes' compact JSON and the places from the
predicate, so every reader must register the same nodes and use the same
predicate. The freeze therefore covers the compact JSON of Lexical's own
nodes, the `children` their classes declare (which the default predicate
reads), and the slot names they declare: changing one of them changes the
positional ids of documents stored without ids that contain such a node,
until the document is first written with its ids. The same holds for an
app's own node classes.

### Test vector

This document, stored without ids except on its last block, loaded with
`RichTextExtension`, `ListExtension` and the default predicate:

```json
{"root":{"children":[{"$":{"10":1.5,"9":"x","note":"tab\tquote\""},"children":[{"text":"Hello, wörld 👋","type":"text"}],"type":"paragraph"},{"children":[{"children":[{"text":"one","type":"text"}],"type":"listitem","value":1},{"children":[{"text":"two","type":"text"}],"type":"listitem","value":2}],"listType":"bullet","start":1,"tag":"ul","type":"list"},{"$":{"blockId":"kept-id"},"children":[],"type":"paragraph"}],"type":"root"}}
```

has this canonical JSON (the compact export leaves out default values such
as the first item's `value` and the list's `start` and `tag`):

```json
{"children":[{"$":{"9":"x","10":1.5,"note":"tab\tquote\""},"children":[{"text":"Hello, wörld 👋","type":"text"}],"type":"paragraph"},{"children":[{"children":[{"text":"one","type":"text"}],"type":"listitem"},{"children":[{"text":"two","type":"text"}],"type":"listitem","value":2}],"listType":"bullet","type":"list"},{"children":[],"type":"paragraph"}],"type":"root"}
```

document key `9fa59b03bb40d3d4ac45b31a472f965a0825ffc10693d4165b1e4dcf956b5dfa`
(hexadecimal), and these ids:

| Place | Block | Id |
| --- | --- | --- |
| `0` | paragraph | `qfDxX6r4J9KOyXNjM0x2X` |
| `1` | list | `nWeVEnzogQyDvzB4_4gMw` |
| `1.0` | first list item | `L9_QRFvuohaGhhqAlzLEB` |
| `1.1` | second list item | `BCreOq5xUSiXSxTd8xMLr` |
| `2` | paragraph | `kept-id` (stored) |

## API reference

[`BlockIdExtension`](/docs/api/modules/lexical_extension#blockidextension) ·
[`BlockIdHTMLExtension`](/docs/api/modules/lexical_html/BlockIdHTMLExtension#blockidhtmlextension)
