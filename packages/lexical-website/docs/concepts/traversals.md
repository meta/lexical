# Node Traversals with NodeCaret

NodeCaret offers a unified and efficient way for traversing the document
tree, making it much easier to correctly implement traversals and avoid
edge cases around empty nodes and collapsed selections.

These new low-level functions were all designed to work together as a
fully featured relatively lightweight API to use in the core to
allow us to gradually address some edge cases and then simplify and shrink
the code. We expect higher-level utilities to be developed and shipped
in @lexical/utils or another module at a later date. The current overhead
should be less than 3kB in a production environment.

The NodeCaret API was introduced in lexical v0.25.0.

## Narrowing traversal results

Node traversal and key lookup methods return base node types. Use a type guard
before accessing subclass-specific methods:

```ts
import {$isTextNode} from 'lexical';

const child = element.getFirstChild();
if ($isTextNode(child)) {
  child.setTextContent('Updated text');
}

const textChildren = element.getChildren().filter($isTextNode);
```

## Concepts

The core concept with `NodeCaret` is that you can represent any specific
point in the document by using an `origin` node, a `direction` that
points towards an adjacent node (`next` or `previous`), and a `type`
to specify whether the arrow points towards a sibling (`sibling`) or
towards a child (`child`).

All of these types have a `D` type parameter that must be a `CaretDirection`, so you
can not accidentally mix up `next` and `previous` carets. Many of them
also have a `T` type parameter that encodes the type of the `origin` node.

:::tip

The methods of a caret are designed to operate on nodes attached to the `origin`
in the designated direction, not the `origin` itself. For example, this code is
a no-op because it will attach a node to the `origin`, and then remove the node
that was just attached.

```ts
// The origin is unaffected (other than being marked dirty)
caret.insert($createTextNode('no-op')).remove();
```

:::

:::warning

Carets are immutable, and designed for low-level usage. There is no attempt
for carets to automatically update based on changes to the document
(this is a common source of bugs when working with `RangeSelection`).
Functions and methods that work with carets and are expected to change the
structure of the document will always return a possibly new caret.

The `origin` of a caret is the exact version of the object that it was
constructed with, all accessor methods on that origin will generally call
`origin.getLatest()` so the operations will see the latest version.

:::

### NodeCaret

`NodeCaret` is any `SiblingCaret` or any `ChildCaret`
* Typically constructed with `$getChildCaretOrSelf($getSiblingCaret(origin, direction))`
  which returns a `ChildCaret` when the origin is an `ElementNode`

:::tip

This type does not include `TextPointCaret` or `TextPointCaretSlice`,
so you will not have to consider those edge cases when you see this
more specific type.

:::

### SiblingCaret

`SiblingCaret` is a caret that points towards a sibling of the origin

* Constructed with `$getSiblingCaret(origin: LexicalNode, direction: CaretDirection)`
* The `next` direction points towards the right
* The `previous` direction points towards the left

|                        | → direction: `'next'`      | ← direction: `'previous'`     |
|------------------------|---------------------------|-------------------------------|
| `getParentAtCaret()`   | `origin.getParent()`      | `origin.getParent()`          |
| `getNodeAtCaret()`     | `origin.getNextSibling()` | `origin.getPreviousSibling()` |
| `insert(node)`         | `origin.insertAfter(node)`| `origin.insertBefore(node)`   |

### ChildCaret

`ChildCaret` is a caret that points towards the first or last child of the origin

* Constructed with `$getChildCaret(origin: ElementNode, direction: CaretDirection)`
* The `next` direction points towards the first child
* The `previous` direction points towards the last child

|                        | ↘ direction: `'next'`      | ↙ direction: `'previous'`     |
|------------------------|----------------------------|-------------------------------|
| `getParentAtCaret()`   | `origin`                   | `origin`                      |
| `getNodeAtCaret()`     | `origin.getFirstChild()`   | `origin.getLastChild()`       |
| `insert(node)`         | `origin.splice(0, 0, node)`| `origin.append(node)`         |

### PointCaret

`PointCaret` is any `TextPointCaret`, `SiblingCaret` or `ChildCaret`. This
type can be used to represent any point in the document that `PointType` can represent.

### TextPointCaret

`TextPointCaret` is basically a `SiblingCaret` with a `TextNode` origin and an `offset` property
* Constructed with `$getTextPointCaret(origin, direction, offset)`
* The `offset` property is an absolute index into the string
* The `next` direction implies all text content after `offset`
* The `previous` direction implies all text content before `offset`
* All methods that are also present on `SiblingCaret` behave in the same way

### TextPointCaretSlice

`TextPointCaretSlice` is a wrapper for `TextPointCaret` that provides a signed `distance`.

* Constructed with `$getTextPointCaretSlice(caret, distance)`
* `$splitTextPointCaretSlice(slice, selection?)` isolates the slice in a text node,
  splitting at its boundaries when needed. It returns `null` for an empty slice
  and the original node for a whole-node slice. Pass the range selection that
  produced the slice to preserve its endpoints, including element points and
  detached selections. Like `TextNode.splitText`, it does not treat token or
  segmented nodes as atomic.
* There are convenience methods like `removeTextSlice()` and `getTextContent()`,
  so it's not generally necessary to know the implementation details here
* `Math.min(caret.offset, caret.offset + distance)` refers to the start offset of the slice
* `Math.max(caret.offset, caret.offset + distance)` refers to the end offset of the slice
* The `direction` of the caret is generally ignored when working with a
  `TextPointCaretSlice`, the slice is in absolute string coordinates

:::info

The property name `distance` was chosen because `length` and `size` are
commonly used on other data structures in JavaScript and Lexical, and they
are overwhelmingly non-negative. While most uses of `distance` are also
non-negative, in some contexts such as computer graphics it is not uncommon
to use
[Signed distance functions](https://en.wikipedia.org/wiki/Signed_distance_function)
where the distance metric is signed.

In SDF terms, the subset of the space is `[offset, ∞)`. Any coordinate less
than the `offset` boundary is a negative distance; otherwise the distance is
non-negative.

:::

### CaretRange

`CaretRange` contains a pair of `PointCaret` that are in the same direction. It
is equivalent in purpose to a `RangeSelection`, and is what you would generally
use for depth first traversals.

* Constructed with `$getCaretRange(anchor, focus)`, `$caretRangeFromSelection(selection)`,
  or `$extendCaretToRange(anchor)`
* The `anchor` is the start of the range, generally where the selection originated,
  and it is "anchored" in place because when a selection grows or shrinks only the
  `focus` will be moved
* The `focus` is the end of the range, where the blinking cursor is, it's the current
  focus of the user
* Anchor and focus must point in the same direction. The `anchor` points towards the first
  node *in the range* and the focus points towards the first node *not in the range*
* The `getTextSlices()` method is essential to handle the literal edge cases where
  the anchor and/or focus are a `TextPointCaret`. These edges are *not* included
  in the default caret iteration of the `CaretRange`.

:::warning

If you are iterating a `CaretRange` you must consider the `getTextSlices()`
separately, they are not included in the iteration. This is so you don't have
to consider `TextPointCaretSlice` at every step. They are literal edge cases
that can only be at the start and/or end and typically have special
treatment (splitting instead of removing, for example).

:::

## Traversal Strategies

<!-- when you update the example code below, please update the tests in packages/lexical/src/caret/__tests__/unit/docs-traversals.test.ts -->

### Adjacent Caret Traversals

The lowest level building block for traversals with NodeCaret is the adjacent caret
traversal, which is supported directly by methods of NodeCaret.

`getAdjacentCaret()` - Gets a `SiblingCaret` for the node attached to
  `origin` in direction. If there is no attached node, it will return `null`

`getParentCaret(rootMode)` - Gets a `SiblingCaret` for the parent node
  of `origin` in the same direction. If there is no parent node, or the parent
  is a root according to `rootMode`, then it will return `null`. `rootMode`
  may be `'root'` to only return `null` for `RootNode` or `'shadowRoot'` to
  return `null` for `RootNode` or any `ElementNode` parent where
  `isShadowRoot()` returns true

`getChildCaret()` - Gets a `ChildCaret` for this origin, or `null` if the
  origin is not an `ElementNode`. Will return `this` if the caret is already
  a `ChildCaret`

For example, iterating all siblings:

```ts
// Note that NodeCaret<D> already implements Iterable<NodeCaret<D>> in this
// way, so this function is not very useful. You can just use startCaret as
// the iterable.
function *$iterSiblings<D extends CaretDirection>(
  startCaret: NodeCaret<D>
): Iterable<SiblingCaret<LexicalNode, D>> {
  // Note that we start at the adjacent caret. The start caret
  // points away from the origin node, so we do not want to
  // trick ourselves into thinking that that origin is included.
  for (
    let caret = startCaret.getAdjacentCaret();
    caret !== null;
    caret = caret.getAdjacentCaret()
  ) {
    yield caret;
  }
}
```

### Examples

Given the following document tree, here are some examples of using the
adjacent node traversal:

Root
* Paragraph A
  * Text A1
  * Link A2
    * Text A3
  * Text A4
* Paragraph B
  * Text B1
* Paragraph C

```ts
// The root does not have sibling nodes
const carets = [...$getSiblingCaret($getRoot(), 'next')];
expect(carets).toEqual([]);
```

```ts
// The adjacent node to a ChildNode is its first or last child
// and is always a SiblingNode. It does not traverse deeper.
const carets = [...$getChildCaret($getRoot(), 'next')];

// next starts at the first child
expect(carets).toEqual([
  $getSiblingCaret(paragraphA, 'next'),
  $getSiblingCaret(paragraphB, 'next'),
  $getSiblingCaret(paragraphC, 'next'),
]);

// previous starts at the last child
const prevCarets = [...$getChildCaret($getRoot(), 'previous')];
expect(prevCarets).toEqual([
  $getSiblingCaret(paragraphC, 'previous'),
  $getSiblingCaret(paragraphB, 'previous'),
  $getSiblingCaret(paragraphA, 'previous'),
]);
```

```ts
// The iteration starts at the node where the head of the "arrow"
// is pointing, which is away from the origin (the tail of the "arrow").
const carets = [...$getSiblingCaret(paragraphB, 'next')];
expect(carets).toEqual([
  $getSiblingCaret(paragraphC, 'next'),
]);

const prevCarets = [...$getSiblingCaret(paragraphB, 'previous')];
expect(prevCarets).toEqual([
  $getSiblingCaret(paragraphA, 'previous'),
]);
```

### Depth First Caret Traversals

The strategy to do a depth-first caret traversal is to use an adjacent caret
traversal and immediately use a `ChildCaret` any time that an `ElementNode`
origin is encountered. This strategy yields all possible carets, but each
ElementNode in the traversal may be yielded once or twice (a `ChildCaret` on
enter, and a `SiblingCaret` on leave). Allowing you to see whether an
`ElementNode` is partially included in the range or not is one of the
reasons that this abstraction exists.

```ts
function *$iterCaretsDepthFirst<D extends CaretDirection>(
  startCaret: NodeCaret<D>
): Iterable<NodeCaret<D>> {
  function step(prevCaret: NodeCaret<D>): null | NodeCaret<D> {
    // Get the adjacent SiblingCaret
    const nextCaret = prevCaret.getAdjacentCaret();
    return (
      // If there is a sibling, try and get a ChildCaret from it
      (nextCaret && nextCaret.getChildCaret()) ||
      // Return the sibling if there is one
      nextCaret ||
      // Return a SiblingCaret of the parent, if there is one
      prevCaret.getParentCaret('root')
    );
  }
  // You may add an additional check here, usually some specific
  // caret to terminate the iteration with (such as the parent caret
  // of startCaret):
  //
  //  `caret !== null || caret.is(endCaret)`
  //
  for (
    let caret = step(startCaret);
    caret !== null;
    caret = step(caret)
  ) {
    yield caret;
  }
}
```

Normally this type of iteration would be done from a `CaretRange`, where you
would specify a precise end caret (focus).

```ts
function $iterCaretsDepthFirst<D extends CaretDirection>(
  startCaret: NodeCaret<D>,
  endCaret?: NodeCaret<D>,
): Iterable<NodeCaret<D>> {
  return $getCaretRange(
    startCaret,
    // Use the root as the default end caret, but you might choose
    // to use startCaret.getParentCaret('root') for example
    endCaret || $getSiblingCaret($getRoot(), startCaret.direction)
  );
}
```

To get all nodes that are entirely selected between two carets:

```ts
function *$iterNodesDepthFirst<D extends CaretDirection>(
  startCaret: NodeCaret<D>,
  endCaret: NodeCaret<D> = $getChildCaret($getRoot(), startCaret.direction),
): Iterable<LexicalNode> {
  const seen = new Set<NodeKey>();
  for (const caret of $getCaretRange(startCaret, endCaret)) {
    const {origin} = caret;
    if ($isChildCaret(caret)) {
      seen.add(origin.getKey());
    } else if (!$isElementNode(origin) || seen.has(origin.getKey())) {
      // If the origin is an element and we have not seen it as a ChildCaret
      // then it was not entirely in the CaretRange
      yield origin;
    }
  }
}
```

### Examples

Given the following document tree, here are some examples of using the
depth-first node traversal (with a `CaretRange`):

Root
* Paragraph A
  * Text A1
  * Link A2
    * Text A3
  * Text A4
* Paragraph B
  * Text B1
* Paragraph C

```ts
// A full traversal of the document from root
const carets = [...$getCaretRange(
  // Start with the arrow pointing towards the first child of root
  $getChildCaret($getRoot(), 'next'),
  // End when the arrow points away from root
  $getSiblingCaret($getRoot(), 'next'),
)];
expect(carets).toEqual([
  $getChildCaret(paragraphA, 'next'),   // enter Paragraph A
  $getSiblingCaret(textA1, 'next'),
  $getChildCaret(linkA2, 'next'),       // enter Link A2
  $getSiblingCaret(textA3, 'next'),
  $getSiblingCaret(linkA2, 'next'),     // leave Link A2
  $getSiblingCaret(textA4, 'next'),
  $getSiblingCaret(paragraphA, 'next'), // leave Paragraph A
  $getChildCaret(paragraphB, 'next'),   // enter Paragraph B
  $getSiblingCaret(textB1, 'next'),
  $getSiblingCaret(paragraphB, 'next'), // leave Paragraph B
  $getChildCaret(paragraphC, 'next'),   // enter Paragraph C
  $getSiblingCaret(paragraphC, 'next'), // leave Paragraph C
]);
```

## Future Direction

It's expected that higher-level abstractions will be built on top of this
outside of the core, either in @lexical/utils or a separate companion package.
This is just designed to be the lowest-level layer with a consistent and
type-safe interface. That sort of abstraction will probably look a little bit
like cheerio or jQuery, but for working with Lexical documents. It is not
expected that more abstractions will be added to the core.

In order to reduce code size and eliminate bugs, more of the core will be
refactored to use NodeCaret internally.

Once this happens, it's possible that the internal structure of PointType
and/or RangeSelection may change to accommodate NodeCaret, as it is more
resilient to document changes (only changes that directly affect the
origin node will "break" the point). A simple version of this would be to
create a caret any time that the point changes, and use that caret
as a fallback if the selection would otherwise be lost.

It may be the case that NodeCaret will become the lowest level API, working
directly with private LexicalNode/ElementNode internals. When/if that happens,
the methods on LexicalNode will remain for backwards compatibility,
but overriding them will not be supported. It isn't particularly safe to
override them as-is anyway, and these overrides are frequently the
root cause of bugs (e.g. parents that remove themselves after an operation
on a child, causing the point to be lost unless the caller was sophisticated
enough to store the array of parents).

## History

Before NodeCaret, Lexical's core API offered a relatively low-level DOM-like
interface for working with nodes and traversing them. It has accumulated
many functions over time for performing various kinds of traversals around
the tree (finding ancestors, children, depth, siblings, etc.), but most of
them are not implemented in a way that makes them easy to combine
efficiently, and many of them have edge cases that are difficult to avoid
and can't really be addressed without breaking compatibility.

Many of these functions also have a lot of edge cases, particularly around
assuming the reference nodes are inclusive. Many are also left-to-right
biased, don't offer an iterative version that can be aborted early or
consumed on the fly, etc.

Refactoring many of these to use something like `PointType` would almost
be sufficient for many of these use cases, but the representation of
that type is inefficient and error-prone as any mutation to the tree
requires that each point be manually recomputed. `PointType` is also
directionless, forcing a specific left-to-right bias into most APIs.
`RangeSelection` can be used in many cases because a direction can
be inferred from any two different points, but that collapses with
a single point. It's also impractical to use `RangeSelection`
concurrently with mutations due to the problems with `PointType`.

NodeCaret was born out of frustration with these APIs and a desire
to unify it all in a coherent way to simplify and reduce errors in
the core.

## Terminology

### Caret

The term Caret was chosen because it is concise and specific term
specific to a point in a text document. Lexical is "an extensible text editor
framework" so it makes sense that navigation in the document would use
terms relevant to text. Most other terms such as Cursor or Point
already have meanings in Lexical and/or are less specific.

See also:
- [Caret](https://developer.mozilla.org/en-US/docs/Glossary/Caret)
- [Caret navigation](https://en.wikipedia.org/wiki/Caret_navigation)

### Origin

The origin is the reference node for a NodeCaret. Absolute coordinates
are determined by combining this origin node and an "arrow" that points
towards to where the adjacent node is (or could be). The "arrow" is
determined by the `direction` and `type` of the caret.

In a way this "arrow" is considered to be something like a unit vector
to indicate the direction, and adding it to an origin allows you to specify
an absolute location relative to that origin. Unlike the other coordinate
systems available in Lexical, it does not need recomputing whenever
siblings or a parent changes, so long as the origin node is still attached.

See also:
- [Origin](https://en.wikipedia.org/wiki/Origin_(mathematics))
- [Unit Vector](https://en.wikipedia.org/wiki/Unit_vector)

### ChildCaret / SiblingCaret

These were chosen because they match the existing methods on `ElementNode`
and `LexicalNode` (`getFirstChild`, `getNextSibling`, etc.)

### Direction

`'next'` and `'previous'` were chosen for direction mostly to match the
existing methods such as `getNextSibling()` that exist in DOM and in Lexical.
Using other words such as `'left'` and `'right'` would be ambiguous since
text direction can be bidirectional and already uses the terms left-to-right
and right-to-left.

### Distance

The property name `distance` was chosen for `TextPointCaretSlice` because
`length` and `size` are commonly used on other data structures in JavaScript
and Lexical, and they are overwhelmingly non-negative. While most uses of
`distance` are also non-negative, in some contexts such as computer graphics
it is not uncommon to use
[Signed distance functions](https://en.wikipedia.org/wiki/Signed_distance_function)
where the distance metric is signed.

In SDF terms, the subset of the space is `[offset, ∞)`. Any coordinate less
than the `offset` boundary is a negative distance; otherwise the distance is
non-negative.
