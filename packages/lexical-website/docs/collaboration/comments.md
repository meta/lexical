---
sidebar_position: 4
---

# Comments and Annotations

Comment threads, review suggestions and similar annotations mark ranges of
text with an id. `@lexical/mark` offers two ways to store those marks:

- [`MarkNode`](/docs/api/modules/lexical_mark#marknode), an inline
  `ElementNode` that wraps the marked text. This is the established API.
- [`MarkStateExtension`](/docs/api/modules/lexical_mark#markstateextension)
  (experimental), which stores the ids as a set-valued
  [NodeState](/docs/concepts/node-state) (`markIds`) on the TextNodes,
  LineBreakNodes and inline DecoratorNodes it covers, with no wrapper
  element. [`defineMarkExtension`](/docs/api/modules/lexical_mark#definemarkextension)
  makes more extensions like it, one per kind of annotation (see
  [Mark flavors](#mark-flavors)).

The ids live on the leaves, so they travel with the text. Typing inside a
marked run adds to the TextNode that carries the ids. Marking part of a run
splits the TextNode, and each part keeps its own ids; neighbors with the same
ids merge back. Copying or cutting text carries its ids, and deleting it
deletes them. There is no element to move or repair. The one exception: text
inserted exactly at the edge of a run stays outside it, as with `MarkNode`
(see [Inserted text](#inserted-text)).

## When to use `MarkStateExtension`

Prefer it when marks overlap or when the document is edited collaboratively
with the Yjs v2 binding (`CollaborationPluginV2__EXPERIMENTAL`) or the
[Yjs 14 binding](./y.md) (`@lexical/y`).

- **Overlap.** Text covered by two comments is a single TextNode carrying
  both ids. With `MarkNode`, overlapping comments become sibling wrappers
  whose `ids` the app has to keep consistent (the playground uses
  `registerNestedElementResolver`).
- **Concurrent edits.** Adding or removing an id only changes NodeState on
  the existing leaves, so a collaborator typing inside a comment, two
  collaborators commenting on the same text, or one resolving a comment
  while another types in it do not move or duplicate text on v2. With
  `MarkNode` the same edits are structural changes that the bindings sync as
  a delete and a re-insert, which can move or duplicate text.

Keep using `MarkNode` when you need one element around the marked content
(for example to render it as a single DOM element), or when you depend on
code that looks for `MarkNode`.

### Moving from `MarkNode`

| `MarkNode`                                            | `MarkStateExtension`                                       |
| ----------------------------------------------------- | ---------------------------------------------------------- |
| `$wrapSelectionInMarkNode(selection, isBackward, id)` | `$addMarkID(id, selection)`                                |
| `markNode.deleteID(id)`, `$unwrapMarkNode(markNode)`  | `$removeMarkID(id, selection?)`                            |
| `$getMarkIDs(node, offset)`, `markNode.getIDs()`      | `$getMarkIDsAtSelection(selection)`, `$getNodeMarkIDs(leaf)` |
| a mutation listener on `MarkNode`                     | the `markIDNodeKeys` output, `registerMarkIDsListener`     |

`$migrateMarkNodesToMarkState()` converts an existing `MarkNode` document.
Run it once per document with a single writer (for example in a headless
editor before the document is shared): the unwrap is a structural change.

## Usage

```ts
import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $addMarkID,
  $getMarkIDsAtSelection,
  $removeMarkID,
  MarkStateExtension,
} from '@lexical/mark';
import {$getSelection, defineExtension} from 'lexical';

const editor = buildEditorFromExtensions(
  defineExtension({
    dependencies: [MarkStateExtension],
    name: 'my-editor',
    theme: {mark: 'comment', markOverlap: 'comment-overlap'},
  }),
);

const threadId = 'c1';
editor.update(() => {
  const selection = $getSelection();
  if (selection) {
    $addMarkID(threadId, selection);
  }
});
// Remove the id everywhere (or pass a selection to remove it from a range).
// To resolve a thread, see Resolving comments below.
editor.update(() => $removeMarkID(threadId));
// The ids at the caret, for example to open the matching thread
editor.read(() => $getMarkIDsAtSelection());
```

- Ids are non-empty strings without whitespace; `$addMarkID` throws on
  anything else, and an invalid id read from JSON, HTML or a collaborator is
  dropped. Short ids keep collaborative documents smaller, since each id is
  stored on every text run it covers.
- Marked leaves get the `mark` theme class (`markOverlap` when they carry
  more than one id) and a `data-lexical-mark-ids` attribute.
- The `markIDNodeKeys` output signal maps each id to the keys of the leaves
  that carry it, for example to scroll to a comment with
  `editor.getElementByKey(key)`.
- `$getNodeMarkIDs` and `$getMarkIDsAtSelection` return new sorted arrays,
  which you may change; changing them does not change the document.
- In JSON, a leaf covered by `c1` and `c2` has `"$": {"markIds": ["c1", "c2"]}`.
  Every peer of a collaborative document should use the extension: it
  registers the state on every node type, so ids read from JSON or from a
  peer are parsed right away.
- `markableNodes` sets which nodes carry ids: node classes and guard
  functions. The default, `DEFAULT_MARKABLE_NODES`, is TextNode,
  LineBreakNode and every inline DecoratorNode; extend it with
  `[...DEFAULT_MARKABLE_NODES, MyNode]`. All peers should use the same set.
- Marking a range also marks the content of the
  [slots](/docs/concepts/named-slots) of the nodes in it.
- `isMarkIDShown` sets which ids are rendered; see
  [Resolving comments](#resolving-comments).
- HTML export leaves the ids out by default, so that they do not leak into
  other applications through the clipboard. Set `exportIDsToHTML: true` to
  write `data-lexical-mark-ids`; HTML imported through the
  [DOM import pipeline](/docs/serialization/dom-import) reads it back.

### Resolving comments

Resolve a comment in your own data rather than in the document: keep its id
on the text, mark its thread resolved in the store that holds your threads,
and ignore resolved ids wherever you show comments (the highlight, the
thread that opens at the caret, a list of comments). Resolving then writes
nothing to the document, and reopening a thread is free: its id never left
the text. It also avoids a race: with `@lexical/yjs`, a collaborator's
concurrent change to the same text can bring a removed id back (see
[Collaboration](#collaboration)).

Then tell the extension which ids to render with `isMarkIDShown`. A leaf is
decorated (the `mark` and `markOverlap` theme classes and the
`data-lexical-mark-ids` attribute) only with the ids it returns `true` for,
so resolved threads are no longer highlighted. The default shows every id.
When a thread is resolved or reopened, assign a new function to the
`isMarkIDShown` output signal, and the marked leaves are re-rendered:

```ts
import {getExtensionDependencyFromEditor} from '@lexical/extension';
import {MarkStateExtension} from '@lexical/mark';
import {configExtension, type LexicalEditor} from 'lexical';

const resolved = new Set<string>();
const isMarkIDShown = (id: string) => !resolved.has(id);

// In the editor's dependencies
configExtension(MarkStateExtension, {isMarkIDShown});

// When a thread is resolved (or reopened, with resolved.delete)
function resolveThread(editor: LexicalEditor, threadId: string) {
  resolved.add(threadId);
  getExtensionDependencyFromEditor(
    editor,
    MarkStateExtension,
  ).output.isMarkIDShown.value = id => !resolved.has(id);
}
```

Assign a new function each time: changing the state that the current one
reads does not re-render anything. The filter only changes rendering. The
ids stay in the document, and `$getMarkIDsAtSelection`, `$getNodeMarkIDs`,
the `markIDNodeKeys` output and HTML export still see every id, so filter
resolved threads out of what you list or open from them. The function is
called while the editor renders, so keep it a cheap read of your own state.

You can instead remove the id with `$removeMarkID(threadId)` when the thread
is resolved. Reopening the thread then means adding its id again over its
range, which your app has to remember. With the [Yjs 14 binding](./y.md)
(`@lexical/y`), which stores each id separately, each removal leaves one
small live format item in the document (about 30 bytes with a short id) that
collaboration cannot safely clean up, so the document grows with every
comment resolved this way (see "Removed set members" in its
[Limits](./y.md#limits)).

## Mark flavors

`MarkStateExtension` stores every id under one key, so a comment, a
suggestion and a highlight look the same and land in the same output. When
an app has several kinds of annotations, make one extension per kind with
`defineMarkExtension`. Each of these _mark flavors_ works like
`MarkStateExtension` (which is itself the default flavor, on `markIds`) on
its own set-valued NodeState key, with its own rendering, config, output
and listeners. Two flavors on the same text never see each other's ids.

```ts
import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $addMarkID,
  $getMarkIDsAtSelection,
  $removeMarkID,
  defineMarkExtension,
} from '@lexical/mark';
import {$getSelection, configExtension, defineExtension} from 'lexical';

export const CommentMarks = defineMarkExtension({
  className: 'comment',
  name: '@app/CommentMarks',
  overlapClassName: 'comment-overlap',
  stateKey: 'commentIds',
});

export const SuggestionMarks = defineMarkExtension({
  className: 'suggestion',
  name: '@app/SuggestionMarks',
  stateKey: 'suggestionIds',
});

// Resolved threads, kept in your own store (see Resolving comments)
const resolved = new Set<string>();

const editor = buildEditorFromExtensions(
  defineExtension({
    dependencies: [
      configExtension(CommentMarks, {
        isMarkIDShown: id => !resolved.has(id),
      }),
      SuggestionMarks,
    ],
    name: 'my-editor',
  }),
);

editor.update(() => {
  const selection = $getSelection();
  if (selection) {
    $addMarkID(CommentMarks, 'c1', selection);
    $addMarkID(SuggestionMarks, 's7', selection);
  }
});
editor.update(() => $removeMarkID(SuggestionMarks, 's7'));
editor.read(() => $getMarkIDsAtSelection(CommentMarks)); // ['c1']
```

- Pass the flavor first to `$addMarkID`, `$removeMarkID`,
  `$getMarkIDsAtSelection`, `$getNodeMarkIDs` and
  `$migrateMarkNodesToMarkState`. Without a flavor they act on
  `MarkStateExtension`, as before.
- A leaf with comment `c1` and suggestion `s7` has
  `"$": {"commentIds": ["c1"], "suggestionIds": ["s7"]}` in JSON and is
  rendered as
  `<span class="comment suggestion" data-lexical-comment-ids="c1" data-lexical-suggestion-ids="s7">`.
  The attribute defaults to `data-lexical-` and the key in kebab case; set
  `attribute` to choose another. A flavor without `className` adds no
  classes (only `MarkStateExtension` uses the `mark` and `markOverlap`
  theme classes).
- Each flavor has its own config (`isMarkIDShown`, `disabled`,
  `markableNodes`, `exportIDsToHTML`; `config` in the definition sets the
  defaults) and its own output signals, read with
  `getExtensionDependencyFromEditor(editor, CommentMarks).output`.
- The `stateKey` is checked by the types: a key that is empty, contains
  whitespace or is `'markIds'` is a type error whose message says how to
  fix it, and `CommentMarks.stateKey` has the type `'commentIds'`. Two
  flavors with the same key or attribute in one editor throw when the
  editor is built.
- Every flavor depends on `MarkBaseExtension`, the shared base. Its
  `flavors` output lists the flavors of the editor by key, and
  `$getMarkIDsByFlavor(node)` returns the ids of every flavor on a node.

### Keeping your store in sync

The ids say which text an annotation covers, nothing more. Keep the
annotation's data (author, body, replies, resolved) in your own store, keyed
by id: copying it onto the text would repeat it on every text run the
annotation covers, and concurrent edits to it would conflict run by run.
Where that store lives is up to the app: a `Y.Map` next to a Yjs document
suits simple apps, and your own database suits products that need
permissions, notifications, queries across documents, moderation or
retention.

`registerMarkIDsListener` keeps the store in step with the text. It is
called after each commit that changes which ids of a flavor are in the
document, with the ids that appeared (`added`), the ids that no leaf
carries any more (`removed`), every id (`ids`) and the update's `tags`, and
once right away when the document already has ids. When all of a comment's
text is deleted, mark the thread orphaned rather than deleting it: an undo,
a redo or a paste of the commented text brings the id back, and the
listener reports it as added. For example, with a `Y.Map` of threads:

```ts
import {registerMarkIDsListener} from '@lexical/mark';
import {COLLABORATION_TAG} from 'lexical';
import * as Y from 'yjs';

const threads = ydoc.getMap<Y.Map<unknown>>('threads');

const unregister = registerMarkIDsListener(
  editor,
  CommentMarks,
  ({added, removed, tags}) => {
    if (tags.has(COLLABORATION_TAG)) {
      // The collaborator that made the edit updates the store
      return;
    }
    ydoc.transact(() => {
      for (const id of removed) {
        threads.get(id)?.set('orphaned', true);
      }
      for (const id of added) {
        threads.get(id)?.delete('orphaned');
      }
    });
  },
);
```

With [`@lexical/y`](./y.md) the document is a Yjs 14 (`@y/y`) document,
which has no `Y.Map`: a shared type's attributes play its part. The same
listener, with each thread a `Y.Node` stored under its id:

```ts
import * as Y from '@y/y';

const threads = ydoc.get('threads');

// In the listener, instead of the transaction above:
ydoc.transact(() => {
  for (const id of removed) {
    const thread = threads.getAttr(id);
    if (thread instanceof Y.Node) {
      thread.setAttr('orphaned', true);
    }
  }
  for (const id of added) {
    const thread = threads.getAttr(id);
    if (thread instanceof Y.Node) {
      thread.deleteAttr('orphaned');
    }
  }
});
```

Nothing is reported while a flavor is `disabled` (its ids stay in the
document); when it is enabled again, the listener gets the net change. An
id pasted from another document is reported as added like any other: the
store decides whether it knows the thread.

### Inserted text

Text inserted by a local edit (typing, an input method, a paste, a drop,
or code that inserts text and leaves the caret after it) gets:

- the ids shared by the text right before and right after the place it was
  inserted, within its paragraph. Text inserted inside a marked run joins
  it; text inserted at its edge does not, as with `MarkNode`. Text inserted
  between two runs that share an id joins that id.
- when it replaces a selection, also the ids that all of the replaced text
  had, so retyping a commented word keeps the comment (`MarkNode` loses the
  comment when all of its text is replaced). When the editor knows the
  replaced selection (see the limitations), this holds whatever letters the
  new text shares with the replaced text: selecting `teh` and typing `t`, or
  an autocorrection to `the`, gives the new text those ids, and pasting `bX`
  over `bc` in `abcde`, where only `cde` is marked, leaves `bX` unmarked.
- its own ids: pasted or dropped content, and new nodes that code inserts,
  keep the ids they came with, wherever they land, and also join the run they
  land inside, the way typed text does. Text inserted into existing text
  has no ids of its own, also when a transform then splits it off into a
  new TextNode: the piece starts out with the very ids of the node it was
  split from (the same array, not a copy), which is how it is told apart
  from inserted content, whose ids are its own array even when they are
  the same ids. So text typed or pasted as plain text after a commented
  hashtag or mention is not commented, as with `MarkNode`, while pasted
  commented text keeps its comment there.

Text that the edit does not delete keeps exactly its ids, also when the
edit moves it into another block (turning a list item into a paragraph, or
a paragraph into a list item that joins the list above it), and when the
editor or a transform moves it into a new TextNode: a hashtag or a mention
created from commented text, a segmented node that typing turns into plain
text. A node that code moves, rather than
creates, is not inserted text: it does not join a run it lands inside. An
id removed with `$removeMarkID` in the same update is not given
back, neither to that text nor to inserted text (see the limitations for
how far that reaches).

A TextNode whose text gets different ids is split when its pieces stay of
its own class: `TextNode`, or the class that replaces it through a node
replacement. Other TextNodes are not split and get every id their text had:
token and segmented nodes, and subclasses whose boundaries their own
transforms set, such as a hashtag or a code highlighting token. In such a
node, text typed at the edge of a mark joins it, and unmarked text that the
node takes in (a code token that grows over the next word) gets its ids.

This does not depend on which TextNode the editor puts the text in. Updates
replayed from history (undo and redo) or tagged `COLLABORATION_TAG` are left
as they are. With `disabled: true`, inserted text keeps whatever ids the
TextNode it lands in has.

### Limitations

- The ids are copied with the text: pasting copied commented text elsewhere
  puts the same id in a second place, as with `MarkNode`.
- Only the change around the caret is adjusted: the changed text of the
  caret's paragraph that unchanged text does not separate from the caret.
  Text that code inserts elsewhere keeps the ids of the TextNode it lands
  in, and text that code moves into a new TextNode elsewhere loses its ids.
  An insertion is also only adjusted when the caret is right after it.
- The selection that an insertion replaces is known when the insertion is
  dispatched as `CONTROLLED_TEXT_INSERTION_COMMAND` or `PASTE_COMMAND`
  (which typing, autocorrection and pasting use), inside an update or not,
  or starts an input method composition in an update of its own, as the
  browser's `compositionstart` does. A composition that code starts and
  writes in one update is compared as text instead, so letters it adds at
  the end of a mark can be left without the mark's ids. Code that replaces a
  selection with `selection.insertText()` directly is treated as the
  smallest edit: the letters the new text shares with the old one keep their
  ids, and only the other letters are inserted. So such a replacement across
  the edge of a mark, starting or ending with the letter it replaces, can
  join the mark.
- Updates that the editor batches into one commit (several updates in the
  same task) are compared with the document from before the commit, as one
  edit. The last insertion or paste command dispatched before the commit
  decides the replaced selection for all of them.
- An id removed with `$removeMarkID` is not given back anywhere in that
  update, or in the updates batched with it: not to text the removal did
  not cover (a removal from a range), and not after the update adds the id
  again. Text that such an update re-creates (a hashtag) or that replaces a
  selection loses that id, also where the removal did not reach. Let the
  editor commit between the removal and such an edit.
- Code that gives a plain `TextNode` the very ids array of a commented
  hashtag or mention and inserts it right after that node inserts what
  looks like text split off it (see above), so at the end of the mark it is
  not marked. Copying NodeState without a round trip through a string
  passes the array on: the node's `exportJSON()` output imported as a plain
  text node, or `$copyNode` of text split off it. Insert the node without
  ids and add them with `$addMarkID`.
- Code that removes ids by re-creating nodes with `$createTextNode` gets
  them back by the rule above when the caret is in that paragraph; use
  `$removeMarkID`.
- If a collaborator edits the paragraph while an input method composition
  is in progress there, the composed text keeps the ids of the TextNode it
  was composed in, so it can join a mark at its edge.
- Open issue: `$addMarkID` over part of a code highlighting token marks
  nothing, or only part of the range
  ([#9491](https://github.com/meta/lexical/issues/9491)).

## Collaboration

`@lexical/yjs` syncs the ids as any other NodeState. Each mark flavor is its
own key, so the ids of a comment and of a suggestion on the same text never
overwrite each other. Both bindings store the ids of one flavor on a leaf as
one value, so:

- **Concurrent changes to the ids of the same text keep one collaborator's
  set** (the last writer wins for that text). Peers still converge on the
  same document, but one change is lost there: an added id can be dropped,
  or a removed id can come back. For example, when one collaborator resolves
  comment `c1` while another adds `c2` to the same text, the text ends up
  either without `c2` (the addition is lost) or with both `c1` and `c2` (the
  removal is lost, so the resolved `c1` reappears).
  Keep the state of each thread (open or resolved) in your own store, and
  ignore the ids of resolved threads when you render (with `isMarkIDShown`)
  or list comments (see [Resolving comments](#resolving-comments)).
- A collaborator's concurrent structural change to the same text, such as
  wrapping it in a link or merging its paragraph into the previous one, can
  drop the marks on it or extend them over neighboring text. Typing exactly
  at the edge of a mark while a peer edits follows the order Yjs gives the
  two edits. Peers always converge on the same document.

The experimental [Yjs 14 binding](./y.md) (`@lexical/y`) stores each id
separately on text, line breaks and nodes stored as their own Yjs node, so
there concurrent additions and removals of different ids all apply: two
collaborators commenting on the same words both keep their comment, and a
comment resolved while another is added stays resolved. Ids on a line such as a paragraph or
heading, a list item, a list or a link are still one value there. Each
mark flavor's key is stored the same way, as a family of its own. Each id
removed there leaves one small format item behind (see
[Resolving comments](#resolving-comments)).

:::caution v1 collaboration

The v1 binding (`CollaborationPlugin`) syncs a TextNode split or merge as a
delete and a re-insert of the text. Adding or removing an id on part of a
run splits that run's TextNode, and a removal that leaves neighbors with the
same ids merges them, so on v1 those edits race like `MarkNode`: typed text
can move and concurrent comments can duplicate text.

:::
