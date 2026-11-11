# `@lexical/fast-check`

[![See API Documentation](https://lexical.dev/img/see-api-documentation.svg)](https://lexical.dev/docs/api/modules/lexical_fast-check)

This package derives [fast-check](https://fast-check.dev) arbitraries from the
serialization schemas Lexical nodes declare on `$config`, so property-based tests
generate exactly the serialized JSON a node's parser accepts.

Install it alongside `fast-check`, which is a peer dependency:

```sh
npm install --save-dev @lexical/fast-check fast-check
```

## Usage

[`nodeArbitrary(NodeClass)`](https://lexical.dev/docs/api/modules/lexical_fast-check#nodearbitrary) generates the node-specific properties of a
serialized node, composing the schemas the class inherits (an element-based
node also gets `direction`/`format`/`indent`/… from `ElementNode`). Every
property is generated independently as present or absent, because that is the
domain parsers actually face: an older document predates a property, and a
compact export omits one whose value equals its default.

The values are typed as the parse shape of the class's own serialized type —
`LexicalParseJSON<SerializedMyNode>` for a `MyNode` that declares
`exportJSON(): SerializedMyNode` — which is what its `updateFromJSON` accepts,
so they can be handed to it without a cast.

```ts
import {nodeArbitrary} from '@lexical/fast-check';
import * as fc from 'fast-check';

fc.assert(
  fc.property(nodeArbitrary(MyNode), props => {
    const json = {...props, type: 'my-node'};
    // importing and re-exporting is a fixed point
    expect(exportOf(importOf(json))).toEqual(exportOf(importOf(exportOf(importOf(json)))));
  }),
);
```

[`nodeArbitrary`](https://lexical.dev/docs/api/modules/lexical_fast-check#nodearbitrary) reads the class's `$config`, so no editor or node instance is
required — but resolving it injects the class's synthesized statics and compiles
its accessor tables, so a class whose schema names an accessor it does not have
throws here. To inspect what a node declares without generating anything, call
`getComposedSchemaFields(NodeClass)` from `lexical` directly.

## Example: proving a clone carries your node's properties

A custom node has to copy its own properties in `afterCloneFrom`, which Lexical
calls whenever `getWritable()` clones the node. Declaring a new property and
forgetting to copy it there is a silent bug: the field still exists on the clone
because the constructor set it, so nothing throws — the node just reverts that
one property to its default the next time anything writes to it.

This is a good fit for a generated test, because a hand-written fixture tends to
use default values, and a dropped property compares equal to its default. The
test looks like it passed precisely when the bug is invisible. [`nodeArbitrary`](https://lexical.dev/docs/api/modules/lexical_fast-check#nodearbitrary)
draws from the schema's own domain instead, so the values are in-domain and
mostly not the default:

```ts
import {nodeArbitrary} from '@lexical/fast-check';
import * as fc from 'fast-check';
import {
  $create,
  $createParagraphNode,
  $getNodeByKey,
  $getRoot,
  createEditor,
  TextNode,
} from 'lexical';

test('a clone carries every property TextNode declares', () => {
  fc.assert(
    fc.property(nodeArbitrary(TextNode), props => {
      const editor = createEditor({
        nodes: [TextNode],
        onError: e => {
          throw e;
        },
      });
      let key, before, original;

      // A node is only cloned *across* updates. Within one, getWritable()
      // hands back the same object, so a single-update test never reaches
      // afterCloneFrom at all.
      editor.update(() => {
        const node = $create(TextNode);
        // Everything but `text` is used exactly as generated. An empty
        // TextNode is removed by normalization between the two updates, so
        // there would be nothing left to clone; a leaf also cannot be a child
        // of the root, hence the paragraph.
        node.updateFromJSON({...props, text: 'x'});
        $getRoot().clear().append($createParagraphNode().append(node));
        [key, original, before] = [node.getKey(), node, node.exportJSON()];
      }, {discrete: true});

      editor.update(() => {
        const writable = $getNodeByKey(key).getWritable();
        expect(writable).not.toBe(original); // a clone really happened
        expect(writable.exportJSON()).toEqual(before);
      }, {discrete: true});
    }),
  );
});
```

When it fails, fast-check shrinks to the smallest value that exposes it, which
names the property for you. Deleting `this.__style = prevNode.__style` from
`TextNode.afterCloneFrom` reports:

```
Counterexample: [{"style":" "}]

-   "style": " ",
+   "style": "",
```

A single space — the smallest style that is not the default `''`, and the only
kind of value that can catch this.
