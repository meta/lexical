# NodeState

The NodeState API introduced in v0.26.0 allows arbitrary state to be added
ad-hoc to any node in a way that participates with reconciliation, history,
and JSON serialization.

## Use Case

NodeState allows your application to define keys that can be stored on
any node with automatic JSON support.

:::tip

You can even add node state to the RootNode to store document-level metadata.

:::

With a combination of NodeState and other APIs such as
[Listeners](listeners.md) or
[Transforms](transforms.md) you can
likely shape the editor to meet your needs without having to do much
[Node Customization](node-replacement.md).

Even when you are subclassing nodes, using NodeState instead of additional
properties to store the node's data can be [more efficient](#efficiency)
and will save you from writing a lot of boilerplate in the constructor,
updateFromJSON, and exportJSON.

## Usage

### createState

[createState](/docs/api/modules/lexical#createstate)
creates a
[StateConfig](/docs/api/modules/lexical#stateconfig)
which defines the key and configuration for your NodeState value.

The key must be locally unique, two distinct StateConfig must not have the
same string key if they are to be used on the same node.

Typical usage will look something like this:

```ts
const questionState = createState('question', {
  parse: (v) => (typeof v === 'string' ? v : ''),
});
```

The required `parse` function serves two purposes:
- It provides a type-safe and runtime-safe way to parse values that were
  serialized to JSON
- When called with `undefined` (or any invalid value) it should return some
  default value (which may be `undefined` or `null` or any other value you
  choose)

In this case, the question must be a string, and the default is an
empty string.

See the
[createState](/docs/api/modules/lexical#createstate)
API documentation for more details, there are other optional settings
that you may want to define particularly if the value is not a primitive
value such as boolean, string, number, null, or undefined.

:::tip

Instead of writing parse functions by hand, use the
[serialization schema combinators](/docs/serialization/#declarative-serialization-schemas-with-config)
from `lexical`, such as `stringValue`, `numberValue`, `enumValue`,
`arrayValue`, `objectValue`, and `nullable`. They are the same ones a node's
`$config` JSON schema uses. A schema is itself a parse function, so it can be
passed directly as `parse`:

```ts
import {arrayValue, createState, stringValue} from 'lexical';

const questionState = createState('question', {parse: stringValue()});
const tagsState = createState('tags', {parse: arrayValue(stringValue())});
```

Because `parse` is just a function, the combinators also compose with schema
libraries such as [zod](https://zod.dev/), [ArkType](https://arktype.io/),
[Effect](https://effect.website/), and [Valibot](https://valibot.dev/). Wrap a
library's validator in a parse function that returns a default for invalid
input, or use `transformValue` to refine what a combinator parsed.

:::

### $getState

[$getState](/docs/api/modules/lexical#getstate) gets the
NodeState value from the given node, or the default if that key was never
set on the node.

```ts
const question = $getState(pollNode, questionState);
```

See also
[$getStateChange](/docs/api/modules/lexical#getstatechange)
if you need an efficient way to determine if the state has changed on two
versions of the same node (typically used in updateDOM, but may be useful in
an update listener or mutation listener).

### $setState

[$setState](/docs/api/modules/lexical#setstate) sets the
NodeState value on the given node.

```ts
const question = $setState(
  pollNode,
  questionState,
  'Are you planning to use NodeState?',
);
```

:::tip

The last argument is a ValueOrUpdater, just like with React's useState
setters. If you use an updater function and the value does not change,
the node and its NodeState *won't* be marked dirty.

:::

## Serialization

The NodeState for a node, if any values are set to non-default values, is
serialized to a record under a single
[NODE_STATE_KEY](/docs/api/modules/lexical#node_state_key)
which is equal to `'$'`.

```json
{
  "type": "poll",
  "$": {
    "question": "Are you planning to use NodeState?"
  }
}
```

:::tip

By default, it is assumed that your parsed values are JSON serializable,
but for advanced use cases you may use values such as Date, Map, or Set
that need to be transformed before JSON serialization. See the
[StateValueConfig](/docs/api/modules/lexical#statevalueconfig)
API documentation.

:::

### Flat serialization with `$config`

Nodes that declare a `StateConfig` in [`$config`](nodes.mdx#creating-custom-nodes-with-config-and-nodestate)
with `flat: true` lift that key to the top level of the serialized node
instead of nesting it under `'$'`. This makes the JSON shape identical
to a legacy node that stored the value as a `__property` instance
variable, so existing payloads continue to round-trip after the node is
migrated to NodeState.

For example, a `ColoredNode` that extends `TextNode` and declares a flat
`color` state (see [Extending TextNode with `$config`](nodes.mdx#extending-textnode-with-config)):

```ts
$config() {
  return this.config('colored', {
    extends: TextNode,
    stateConfigs: [{flat: true, stateConfig: colorState}],
  });
}
```

serializes as:

```json
{
  "type": "colored",
  "text": "hello",
  "color": "red"
}
```

A non-flat (default) state on the same node would instead appear under
`'$'`:

```json
{
  "type": "colored",
  "text": "hello",
  "$": {
    "color": "red"
  }
}
```

In both cases, a key is only emitted when the current value is not equal
to the default returned by its `parse` function — see
[Efficiency](#efficiency).

:::note

Don't reuse a flat key that a superclass already serializes (e.g. `text`
on `TextNode`).

:::

### Upgrading a legacy JSON property to NodeState

A node that stores data as a `__property` instance variable with custom
`exportJSON`/`importJSON`/`updateFromJSON` can be migrated to NodeState
with `flat: true` without changing its serialized JSON shape.

Before — `ColoredNode` with a `__color` property and hand-written
serialization (see the full legacy example in
[Extending TextNode with `$config`](nodes.mdx#extending-textnode-with-config)):

```ts
export type SerializedColoredNode = Spread<
  {color?: string},
  SerializedTextNode
>;

export class ColoredNode extends TextNode {
  __color: string;

  constructor(text: string = '', color: string = DEFAULT_COLOR, key?: NodeKey) {
    super(text, key);
    this.__color = color;
  }

  static getType(): string {
    return 'colored';
  }

  static clone(node: ColoredNode): ColoredNode {
    return new ColoredNode(node.__text, node.__color, node.__key);
  }

  static importJSON(serializedNode: SerializedColoredNode) {
    return new ColoredNode().updateFromJSON(serializedNode);
  }

  updateFromJSON(serializedNode: SerializedColoredNode) {
    const self = super.updateFromJSON(serializedNode);
    self.__color =
      typeof serializedNode.color === 'string'
        ? serializedNode.color
        : DEFAULT_COLOR;
    return self;
  }

  exportJSON(): SerializedColoredNode {
    return {
      ...super.exportJSON(),
      color: this.__color === DEFAULT_COLOR ? undefined : this.__color,
    };
  }
}
```

After — same on-the-wire JSON, no hand-written serialization:

```ts
const colorState = createState('color', {
  parse: (v) => (typeof v === 'string' ? v : DEFAULT_COLOR),
});

export class ColoredNode extends TextNode {
  $config() {
    return this.config('colored', {
      extends: TextNode,
      stateConfigs: [{flat: true, stateConfig: colorState}],
    });
  }
}
```

No `exportJSON`, `importJSON`, `updateFromJSON`, `clone`, or
`afterCloneFrom` override is needed: `$config` installs `clone` and
`importJSON`, and the base `exportJSON`/`updateFromJSON`/`afterCloneFrom`
on `LexicalNode`/`TextNode` already round-trip NodeState. Read the color
via `$getState(node, colorState)` and write it via
`$setState(node, colorState, value)` instead of `node.__color`.

:::tip

For a seamless migration, keep the JSON key name the same — for a flat
state, that's the first argument to `createState`. Migrating from a
non-flat NodeState to a flat NodeState also works: state that appears
under the `$` (`NODE_STATE_KEY`) is still parsed even when the state is
configured as flat, and the flat value takes precedence when both are
present.

:::

## Efficiency

NodeState uses a copy-on-write scheme to manage each node's state. If
none of the state has changed, then the NodeState instance will be
shared across multiple versions of that node.

:::info

In a given reconciliation cycle, the first time a Lexical node is marked dirty
via `getWritable` will create a new instance of that node. All properties
of the previous version are set on the new instance. NodeState is stored
as a single property, and no copying of the internal state is done
until the NodeState itself is marked writable.

:::

When serializing to JSON, each key will only be stored if the value
is not equal to the default value. This can save quite a lot of space
and bandwidth.

Parsing and serialization is only done at network boundaries, when
integrating with JSON or Yjs. When a value changes from an external
source, it is only parsed once the first time it is read.
Values that do not come from external sources are not parsed, and
values that are not used are never parsed.

## Set-valued state

For state that is a small set of strings, such as the ids of the comments on
a piece of text or a few tags, use `arraySetValue` (experimental) with an
item schema:

```ts
import {$getState, $setState, arraySetValue, createState, stringValue} from 'lexical';

const tagsState = createState('tags', {parse: arraySetValue(stringValue())});
//    ^? StateConfig<'tags', readonly string[]>

$setState(node, tagsState, ['b', 'a', 'a']);
$getState(node, tagsState); // ['a', 'b']
```

The value is an array used as a set: it is sorted (by UTF-16 code unit) and
has no duplicates, so its order does not matter. Parsing drops duplicates
and entries the item schema does not accept, and a value written with
`$setState` is put into the same form, so `['b', 'a', 'a']` is stored, read
back and compared as `['a', 'b']`. Two values are equal when they have the
same members, the empty array is the default (and so is left out of the
JSON), and the JSON is the same sorted array (`"$": {"tags": ["a", "b"]}`),
so equal sets always serialize identically.

The value is frozen, so changing it in place (`push`, `sort`, assigning an
index) throws in strict mode code, which includes every ES module. To change
it, write a new array with `$setState`:

```ts
$setState(node, tagsState, (prev) => [...prev, 'c']);
$setState(node, tagsState, (prev) => prev.filter((tag) => tag !== 'a'));
```

It is meant for small sets. A large set does not belong in NodeState: every
change builds and stores a new copy of the whole array.

Declare the state in the node's `$config` `stateConfigs` so that JSON is
parsed, and so written back canonical, when it is loaded; like any
NodeState, a value that is neither declared nor read is written back as it
was read. `arraySetValue` must be the whole value of a `createState`; it
cannot be nested in another schema or used for a node property. The item
schema must produce strings; one that declines some strings in its
`accepts` (a hand-written schema) makes parsing drop them, which is how a
set can admit only well-formed members.

The schema says the state is a set: `stateConfig.schema?.meta.kind === 'set'`
(with `meta.item`) marks the value as a set whose members are independent,
so code that stores or merges values can treat each member separately.

## Capabilities

Current:

- Allows you to define and add state to any node
- Serializes that state automatically in the node's JSON, supporting
  versioning and copy+paste
- Works with the reconciler, TextNodes with differing state will not
  be implicitly merged
- @lexical/yjs support, NodeState will be automatically synchronized
  like any other property
- NodeState values that are not used will simply pass-through, making
  it a bit easier for situations where multiple configurations are used
  on the same data (e.g. older and newer versions of your editor,
  a different set of plugins based on context, etc.).
- Pre-registration system for nodes to declare expected state
  and serialize them as top-level properties (`flat`) with `$config`
  (see [#7260](https://github.com/meta/lexical/issues/7260)).
- Can be integrated with
  [DOMRenderExtension](../serialization/dom-render.md) for editor
  rendering and HTML export
- Can be integrated with
  [DOMImportExtension](../serialization/dom-import.md) for HTML import

Future:

- Does not yet support direct integration with Yjs, e.g.
  you can not store a Y.Map as a NodeState value
  (see [#7293](https://github.com/meta/lexical/issues/7293))

## Node State Style Example

This example demonstrates an advanced use case of storing a style object on TextNode using NodeState.

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/meta/lexical/tree/main/examples/node-state-style?file=src/main.tsx)

<iframe width="100%" height="600" src="https://stackblitz.com/github/meta/lexical/tree/main/examples/node-state-style?embed=1&file=src%2FApp.tsx&terminalHeight=0&ctl=1&showSidebar=0&devtoolsheight=0&view=preview" sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-presentation allow-same-origin allow-scripts" title="Node State Style Example"></iframe>
