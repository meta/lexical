# Named Slots

:::warning

Named slots are experimental. The APIs described here are tagged
`@experimental`, may change without a major version bump, and the
serialization and collab formats should be treated as unstable until the
feature is stabilized.

:::

Named slots let a single host node (an ElementNode or a DecoratorNode) own
several isolated editable regions addressed by name — a Card's `title`, a
PullQuote's `quote` and `attribution` — inside the host's own EditorState.
Each region takes its own caret and formatting, never merges across the
boundary, and `Cmd+A` doesn't spill into the rest of the document.

Before named slots, the usual answer was a nested editor per region: every
region lives in its own EditorState, so moving nodes between regions and
keeping history and collab in sync all require serialization and extra
`editor.update` passes. The other node shapes don't fit either: plain
ElementNode children share one undivided linked list (Backspace at a region
start merges it into the previous region), and a DecoratorNode is atomic, so
Lexical can't own selection, collab, or serialization inside it. With named
slots, editing a slot is just editing the one tree.

:::note

Named slots are the model-level generalization of the rendering concept
behind [`$getDOMSlot`](/docs/api/modules/lexical#getdomslot) /
`ElementDOMSlot` in the
[DOM rendering](../serialization/dom-render.md) documentation. Every
ElementNode already has one _unnamed_ children channel, and `$getDOMSlot`
controls where that channel's content attaches in the node's DOM. Named
slots are additional, explicitly-named channels alongside it — symmetric in
that each renders into a controllable location in the host's DOM — but they
also carry the model-level semantics the unnamed channel doesn't: isolation
(the virtual shadow root below), a separate NodeKey map, and their own
serialization and collaboration.

:::

## The Model

A host keeps a second child channel, a `Map` of slot name to NodeKey,
separate from its ordinary linked-list children. A slot value has its slot
host pointer set and `getParent() === null`, with exactly one of the two
non-null: `getParent()` stops at the slot boundary, and you climb out only
through [`$getSlotHost()`](/docs/api/modules/lexical#getslothost).

The slot link itself acts as a **virtual invisible shadow root** between the
host and the value. Isolation is structural rather than a convention — an
accidental boundary crossing surfaces as a thrown invariant, not silent
corruption.

In the DOM, each value renders synchronously into a keyless
`<div data-lexical-slot="<name>">` container parked slots-first in the host
DOM as a **hidden placeholder** (`display: none`), in a canonical order
derived from the host class (see [slot order](#slot-order)). Nothing is
visible until the host explicitly attaches the container somewhere (see
[Rendering](#rendering)) — mirroring how
[`getDOMSlot`](/docs/api/modules/lexical#getdomslot) gives an element
control over where its linked-list children render.

## Hosts and Values

Any ElementNode or DecoratorNode can host slots. An ElementNode host can mix
slots with ordinary children (a Card with a `title` slot plus regular body
paragraphs); a DecoratorNode host has no children channel, so slots are its
only editable content (a PullQuote that is otherwise atomic).

A slot value is any non-inline ElementNode or DecoratorNode. The value's
shape decides the editing model:

- **A bare block** (for example a ParagraphNode) behaves as a single-line
  field with no extra wrapper in the model, the JSON, or the DOM: its virtual
  scope holds exactly one block, so Enter is a no-op (hosts may map it to
  focus movement) and a multi-block paste flattens to inline content the way
  an `<input>` sanitizes its value — line breaks stripped, block-only
  decorators dropped.
- **A shadow-root container** (an ElementNode whose
  [`isShadowRoot()`](/docs/api/modules/lexical#isshadowroot) returns
  `true`) behaves as a multi-block region with normal block editing inside.

## Declaring and Setting Slots

A host class declares its slot names in [`$config()`](nodes.mdx); values are
attached with [`$setSlot`](/docs/api/modules/lexical#setslot):

```ts
import {
  $create,
  $createParagraphNode,
  $setSlot,
  ElementNode,
} from 'lexical';

class CardNode extends ElementNode {
  $config() {
    return this.config('card', {extends: ElementNode, slots: ['title']});
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): boolean {
    return false;
  }
}

function $createCardNode(): CardNode {
  const card = $create(CardNode);
  // Single-line title: the bare paragraph IS the slot value. An empty
  // paragraph is an empty field; to seed default text, append a non-empty
  // TextNode (empty TextNodes are eliminated during reconciliation).
  $setSlot(card, 'title', $createParagraphNode());
  // Ordinary body child, edited like any other block.
  return card.append($createParagraphNode());
}
```

For a multi-block region, use a shadow-root container as the value:

```ts
class SlotContainerNode extends ElementNode {
  $config() {
    return this.config('slot-container', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): boolean {
    return false;
  }
  isShadowRoot(): boolean {
    return true;
  }
}

$setSlot(
  pullQuote,
  'quote',
  $create(SlotContainerNode).append(
    $createParagraphNode().append($createTextNode('First block')),
    $createParagraphNode().append($createTextNode('Second block')),
  ),
);
```

The core API surface (all exported from `lexical`):

- [`$setSlot(host, name, node)`](/docs/api/modules/lexical#setslot) — place a value into a named slot, replacing
  any existing value under that name. Move semantics, mirroring `append`:
  the value is detached from any current parent or slot first. Throws if the
  value is inline or if the name is one of the reserved prototype keys
  (`__proto__`, `constructor`, `prototype`). Slotting a node into its own
  descendant would form a cycle; this is checked (and throws) in development
  only — in production it behaves like appending an ancestor through the
  children channel, which is likewise unguarded.
- [`$getSlot(host, name)`](/docs/api/modules/lexical#getslot) — the value under a name, or `null`.
- [`$getSlotNames(host)`](/docs/api/modules/lexical#getslotnames) — the host's slot names in canonical order.
- [`$removeSlot(host, name)`](/docs/api/modules/lexical#removeslot) — detach the value under a name (the subtree is
  garbage-collected unless you reattach it elsewhere).
- [`$getSlotHost(node)`](/docs/api/modules/lexical#getslothost) — the host a value is slotted into, or `null`.
- [`$getSlotNameWithinHost(node)`](/docs/api/modules/lexical#getslotnamewithinhost) — the name of the slot
  a value occupies on its host (the reverse direction of `$getSlotHost`), or
  `null` when the node is not a slot value.
- [`$getSlotFrame(node)`](/docs/api/modules/lexical#getslotframe) — the innermost slot value containing a node (the
  "frame" whose virtual shadow root scopes editing), or `null` when the node
  is not inside any slot.
- [`$getSelectionSlotFrame(selection)`](/docs/api/modules/lexical#getselectionslotframe) — the slot frame a
  selection lives in, or `null` when it is outside any slot. Selection-driven
  exporters walk this frame instead of the root's children, because a
  selection inside a slot never contains its host and a root walk would
  export nothing. Works for every selection type, not just `RangeSelection`.
- [`$isSlotHost(node)`](/docs/api/modules/lexical#isslothost) /
  [`$isSlotChild(node)`](/docs/api/modules/lexical#isslotchild) — type guards
  for the [`SlotHostNode`](/docs/api/modules/lexical#slothostnode) /
  [`SlotChildNode`](/docs/api/modules/lexical#slotchildnode) interfaces.

## Slot Order

Slot order is canonical and derived, never stored. Names declared in
`$config()` (`slots: ['quote', 'attribution']`) sort first in declaration
order; undeclared names sort after them, lexicographically by UTF-16 code
unit (plain JavaScript string comparison, locale-independent). `$setSlot`
re-canonicalizes on every write, so documents normalize on load and
concurrent collaborative additions converge to the same order on every
client. If presentation order matters, declare the names.

## Rendering

The reconciler always renders every slot subtree synchronously, but into a
hidden placeholder container — visibility is the host's explicit decision.
There are three ways to attach a slot, all sharing the same contract
(attaching moves the container to the target, a no-op when it is already
there, and reveals it; the container renders as a normal block):

1. **Synchronously in-lexical**: register a `$getSlotTargetElement`
   [`DOMRenderMatch`](/docs/api/modules/lexical_html#domrendermatch)
   override for the host's node class (a
   [DOM render override](../serialization/dom-render.md), not a node
   method — this is an advanced hook). The reconciler consults it whenever
   it creates or reconciles the slot's container and attaches/reveals
   within the same commit — no listener or framework hop. Returning
   `hostDom` reveals the slot in its default slots-first position:

   ```ts
   import {domOverride, DOMRenderExtension} from '@lexical/html';
   import {configExtension, defineExtension} from 'lexical';

   export const CardExtension = defineExtension({
     dependencies: [
       configExtension(DOMRenderExtension, {
         overrides: [
           domOverride([CardNode], {
             // Reveal the title in its default slots-first position within
             // the same commit that renders it. Returning an element from
             // deeper inside the host's DOM attaches it there instead;
             // $next() defers to lower-priority overrides (default: null,
             // a hidden placeholder).
             $getSlotTargetElement: (node, slotName, hostDom, $next, editor) =>
               hostDom,
           }),
         ],
       }),
     ],
     name: 'card',
     nodes: [CardNode],
   });
   ```

2. **Imperatively**:
   [`mountSlotContainer(editor, nodeKey, slotName, target)`](/docs/api/modules/lexical#mountslotcontainer)
   and
   [`unmountSlotContainer(editor, nodeKey, container)`](/docs/api/modules/lexical#unmountslotcontainer)
   from `lexical` are the framework-independent primitives (e.g. from a
   [mutation listener](/docs/api/modules/lexical#registermutationlistener),
   which fires after the commit). `mountSlotContainer` resolves the container
   against the committed editor state
   ([`editor.getEditorState()`](/docs/api/modules/lexical#geteditorstate)), so
   the model it reads matches the reconciled DOM it reveals;
   `unmountSlotContainer` takes the container you already hold and only touches
   the DOM:

   ```ts
   import {mountSlotContainer} from 'lexical';

   // e.g. inside an extension's register(editor):
   const unregister = editor.registerMutationListener(
     CardNode,
     (mutations) => {
       for (const [nodeKey, mutation] of mutations) {
         if (mutation === 'destroyed') {
           continue;
         }
         const hostDom = editor.getElementByKey(nodeKey);
         if (hostDom !== null) {
           // Mounting in place: the placeholder is already parked in the
           // host DOM, so this just reveals it in its slots-first position.
           // Any element within the host's DOM works as a target.
           mountSlotContainer(editor, nodeKey, 'title', hostDom);
         }
       }
     },
     {skipInitialization: false},
   );
   ```

   `unmountSlotContainer(editor, nodeKey, container)` is the reverse: it
   hides the container and parks it back in the host DOM, for when a mount
   target goes away while the host remains.

3. **From React chrome**: the
   [`useLexicalSlotRef`](/docs/api/modules/lexical_react_useLexicalSlotRef#uselexicalslotref)
   hook from `@lexical/react/useLexicalSlotRef` wraps the imperative pair and returns a
   ref that mounts a slot's container into your component — the usual choice
   for a DecoratorNode host's `decorate()` chrome (whose containers are
   opted back into `contentEditable` automatically, since the decorator DOM
   is non-editable):

```tsx
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {useLexicalSlotRef} from '@lexical/react/useLexicalSlotRef';

function PullQuoteComponent({nodeKey}: {nodeKey: NodeKey}) {
  const [editor] = useLexicalComposerContext();
  const quoteRef = useLexicalSlotRef<HTMLDivElement>(editor, nodeKey, 'quote');
  const attributionRef = useLexicalSlotRef<HTMLDivElement>(
    editor,
    nodeKey,
    'attribution',
  );
  return (
    <blockquote>
      <div ref={quoteRef} />
      <div ref={attributionRef} />
    </blockquote>
  );
}
```

A `contentEditable=false` ElementNode shell can host React chrome the same
way (slot containers opt into editing whenever the host DOM is
non-editable): the playground's Review demo portals chrome into the host DOM,
attaches the author slot with `useLexicalSlotRef`, drives an interactive
star-rating widget that persists to NodeState, and applies the identical
hidden-then-attach technique to its `getDOMSlot` children element. Such a shell should call
[`setDOMUnmanaged(dom)`](/docs/api/modules/lexical#setdomunmanaged) in
`createDOM` — the portal and the
attach moves mutate the shell's children from outside the reconciler, and
the marker gives the shell the same mutation-observer exemption a
DecoratorNode's DOM has.

## Editable state

A slot rendered inside a non-editable host (a DecoratorNode, or a
`contentEditable=false` element shell) would not track the editor's editable
state on its own, so the reconciler gives its container an explicit
`contentEditable` that follows `editor.isEditable()`, and re-renders the islands
whenever `setEditable` toggles — so a read-only editor's slots are not left
editable. No extension is required. Slots always follow the editor; there is
currently no way for a slot to override its own editable state.

A host that attaches its own editable island which is *not* a slot container —
for example the Review demo's `getDOMSlot` children element inside its
`contentEditable=false` shell — opts it into the same behavior with
[`$markSlotEditable(element, editor)`](/docs/api/modules/lexical#marksloteditable),
re-applying it from `updateDOM` so an editable toggle reaches the island.

## Editing Behavior

- **Selection never crosses a slot boundary.** Selections are clamped to the
  anchor's slot frame at every entry point (DOM resolution,
  [`$setSelection`](/docs/api/modules/lexical#setselection),
  and point mutation), so a mouse drag and a `shift+arrow` across the
  boundary land on the same clamped result.
- **Deletion stops at the boundary.** Backspace at the start of a slot and
  forward-Delete at its end are no-ops instead of merging across the virtual
  shadow root.
- **`Cmd+A` scopes to the slot frame** when the caret is inside one; outside
  slots the default handlers keep the legacy whole-document behavior.
  Progressive expansion (block → enclosing slot frame → document on repeated
  presses) is provided by the opt-in
  [`SelectBlockExtension`](/docs/api/modules/lexical_extension#selectblockextension)
  from `@lexical/extension`.
- **Generic block conversion skips slot values.** A slot value has no
  parent — its up-link is `$getSlotHost` — so selection-driven block
  converters (`$setBlocksType`, `$wrapNodes`, `$insertList` / `$removeList`,
  the markdown block shortcuts) treat it as ineligible and do nothing rather
  than replace it: the slot assignment is managed by the node or extension
  that owns the slot. Calling `LexicalNode.replace` directly on a slot value
  throws; reassign the slot with `$setSlot` on its host instead.
- **Slots stay bound to their host through `replace`.** Replacing a slot
  *host* (`host.replace(other)`) does not transfer its slots to the
  replacement — slots are not necessarily portable across node types, so the
  slot map travels with the node, never with its position. If the replaced
  host is reattached in the same update (the
  [`$wrapNodeInElement`](/docs/api/modules/lexical_utils#wrapnodeinelement)
  pattern) it keeps its slots; if it stays detached, its slot subtrees are
  garbage-collected with it. The same applies to anything built on `replace`:
  converting a slot host with `$setBlocksType` produces a slot-less
  replacement block. Move a slot onto another host explicitly with
  `$setSlot`.
- **A NodeSelection of an element carries its children.** Copy and export
  of a whole-host NodeSelection (e.g. a chrome click that selects "the whole
  Card") include the host's body children even though they aren't in the
  selection themselves — the old shell-only output made cut silently lossy.
  This applies only to NodeSelection; a partial RangeSelection over the host
  keeps per-child slicing.

### Traversal is intentionally asymmetric

Content reads include slot subtrees, slots-first:
[`getTextContent()`](/docs/api/modules/lexical#gettextcontent),
[`getAllTextNodes()`](/docs/api/modules/lexical#getalltextnodes),
and the [`$dfsWithSlots`](/docs/api/modules/lexical_utils#dfswithslots)
family in `@lexical/utils` count slot content for search, copy, and
accessibility. Navigation excludes them:
[`getChildren()`](/docs/api/modules/lexical#getchildren),
[`getFirstDescendant()`](/docs/api/modules/lexical#getfirstdescendant)
and friends stay linked-list-only, so caret movement never walks into a slot
by accident. Choose [`$dfs`](/docs/api/modules/lexical_utils#dfs) or
[`$dfsWithSlots`](/docs/api/modules/lexical_utils#dfswithslots) depending on whether "this subtree" should mean the
navigable tree or all content.

## Serialization

JSON serialization is automatic in both directions. A host's slots serialize
under the reserved `$slots` key on
[`SerializedLexicalNode`](/docs/api/modules/lexical#serializedlexicalnode)
(a sibling of
NodeState's reserved `'$'` key), keyed by slot name:

```json
{
  "type": "card",
  "version": 1,
  "$slots": {
    "title": {"type": "paragraph", "children": [], "version": 1}
  },
  "children": []
}
```

Parsing re-attaches each subtree with `$setSlot` and throws if `$slots`
appears on a node that cannot host slots. The `$` prefix keeps the
framework-owned key from colliding with a subclass that already serializes a
`slots` property of its own.

HTML serialization is opt-in per host, like NodeState: the exporter never
descends into slots on its own. A host's `exportDOM` can emit each slot into
a wrapper using
[`$appendNodeToHTML`](/docs/api/modules/lexical_html#appendnodetohtml) from
`@lexical/html`, and a
[DOM import rule](../serialization/dom-import.md) on the host's
distinguishing markup maps the wrappers back through `$setSlot`.

## Collaboration

Slots sync on both the V1 and V2 Yjs bindings through a per-slot-diffed
`Y.Map` stored under the reserved `__slots` attribute key on the host's shared
type (the channel reuses the host's `__slots` field name, which is already
excluded from the property sync). Hosts with declared slots create that map
eagerly, so two clients
concurrently setting *different* slot names for the first time merge
per-entry instead of racing. Malformed or hostile remote entries are
validated and skipped.

:::caution

Pre-slots clients receiving slot data from upgraded peers will error rather
than render it. Enabling slots in long-lived shared documents should be
gated on all participants running a slots-aware version; new clients
tolerate unknown slot data going forward.

:::

## Reserved Names

Adding slots reserves a few identifiers that custom node subclasses should
not define for their own purposes:

- the `__slots` and `__slotHost` fields on ElementNode / DecoratorNode — the
  `__slots` name is also the collab attribute key for the slots channel, so it
  is reserved on the Yjs shared type too;
- the `$slots` serialized JSON key.

## Current Limitations

- The caret / NodeCaret APIs throw across a slot boundary ("no common
  ancestor"); slot-aware caret traversal is a planned follow-up.
- Nested slots (a slot whose host is itself slotted) are only handled one
  level deep by the runtime selection comparator.
- The mixed-version collab caveat above.
