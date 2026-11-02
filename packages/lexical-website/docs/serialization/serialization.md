

# Serialization & Deserialization

Internally, Lexical maintains the state of a given editor in memory, updating it in response to user inputs. Sometimes, it's useful to convert this state into a serialized format in order to transfer it between editors or store it for retrieval at some later time. In order to make this process easier, Lexical provides some APIs that allow Nodes to specify how they should be represented in common serialized formats.


## Formats at a glance {#formats-at-a-glance}

Every format works the same way: Lexical walks the node tree and asks each
node, or an extension, how to convert it. Because the tree is already shaped
like HTML (see [Document Model](../concepts/document-model.md)), a link exports
as an `<a>` around the text nodes it already contains.

| Format | How |
| -- | -- |
| JSON | `editorState.toJSON()` writes the node tree, and `editor.parseEditorState()` reads it back. Each node class declares its properties in a `$config` serialization schema, and its JSON conversion is generated from that. |
| HTML export | `$generateHtmlFromNodes(editor, selection)` from `@lexical/html`. By default a node exports the element its `createDOM()` renders, and a [`DOMRenderExtension`](./dom-render.md) override can change that. |
| HTML import | `$generateNodesFromDOMViaExtension(dom)` from `@lexical/html`, using the import rules that your extensions register with [`DOMImportExtension`](./dom-import.md) |
| Markdown | [`@lexical/markdown`](/docs/packages/lexical-markdown) (transformers) or [`@lexical/mdast`](./markdown-mdast.md) (CommonMark and GFM through micromark and mdast), both with `$convertToMarkdownString()` and `$convertFromMarkdownString()` |
| Clipboard | Copy writes plain text, HTML, and Lexical JSON (`application/x-lexical-editor`). Paste uses the JSON when it is present, then HTML, then plain text. |

The JSON follows the tree too: a link is a `link` node with its text nodes as
`children`, and bold is a `format` value on a `text` node. The default HTML
export reuses `createDOM()`, the same definition that renders the editor, so
the two stay in step unless you override one. For how each format compares
with ProseMirror, see
[Compared with ProseMirror](../concepts/compared-with-prosemirror.md#serialization).

HTML import and export need a DOM. Outside a browser, run them inside
`withDOM()` from `@lexical/headless/dom`, as described in
[Running Without a Browser](../concepts/headless.md). JSON and Markdown do not
need a DOM. The rest of this page covers JSON and HTML in detail. For code that
defines HTML conversion on each node class with `importDOM()` and
`exportDOM()`, or writes its JSON methods by hand, see
[Legacy HTML and JSON Serialization](./legacy.md).

## JSON

JSON is the format for saving and restoring a document. It records the whole
node tree, so a document restores exactly as it was, and most nodes need no
serialization code at all: each node class declares its properties once in a
[serialization schema](#declarative-serialization-schemas-with-config), and
Lexical generates the conversion in both directions from it.

### Lexical -> JSON

To generate a JSON snapshot from an `EditorState`, call its `toJSON()` method:

```js
const editorState = editor.getEditorState();
const json = editorState.toJSON();
```

Or, to get a string, use `JSON.stringify` directly:

```js
const jsonString = JSON.stringify(editor.getEditorState());
```

### JSON -> Lexical

To restore a document, parse the JSON (or its string form) with
`editor.parseEditorState()` and pass the result to `editor.setEditorState()`:

```js
editor.setEditorState(editor.parseEditorState(jsonString));
```

To load a document when the editor is created, pass the JSON string as the
`$initialEditorState` of your editor's extension. The editor must have the
same node classes registered (through the same extensions) as the one that
wrote the JSON. See [Editor State](../concepts/editor-state.md) for more.

:::tip

Properties that aren't part of a node class, such as data your application
attaches to existing nodes, can be stored with
[`NodeState`](../concepts/node-state.md), which is also serialized
automatically. See
[Flat serialization with `$config`](../concepts/node-state.md#flat-serialization-with-config).

:::

### Declarative serialization schemas with `$config`

Serialization schemas are available in Lexical v0.51.0 and later. For nodes
that don't declare one, see
[Legacy JSON methods](./legacy.md#legacy-json-methods).

A node that uses [`$config`](../concepts/nodes.mdx#creating-custom-nodes-with-config-and-nodestate)
declares its serialized properties once, as a schema, in the `json` property.
That declaration is the single source of truth for both directions: the base
`updateFromJSON` applies it, the base `exportJSON` writes from it, and `$config`
synthesizes `importJSON` when the constructor has no required arguments. Every
built-in node declares one, and most custom nodes need no JSON serialization
code at all.

```ts
import {
  $getDocument,
  ElementNode,
  enumValue,
  nodeSchema,
  numberValue,
  withField,
} from 'lexical';

// Above the class, as every built-in node does. A class's *type* is in scope
// before its definition, and writing it inline turns the check into a cycle.
// See "Where to write the schema" below.
const counterSchema = nodeSchema<CounterNode>()({
  // `withField` says where the property is stored, which is what lets the
  // export read it, the parse assign it, and a clone carry it across.
  count: withField(numberValue(), {field: '__count'}),
  variant: withField(enumValue(['a', 'b']), {field: '__variant'}),
});

class CounterNode extends ElementNode {
  __count = 0;
  __variant: 'a' | 'b' = 'a';

  $config() {
    return this.config('counter', {extends: ElementNode, json: counterSchema});
  }

  createDOM(): HTMLElement {
    return $getDocument().createElement('div');
  }

  updateDOM(): boolean {
    return false;
  }

  // Accessors for callers. The schema names the fields and does not need
  // these, but a node with no way to set its properties is not much use.
  setCount(count: number): this {
    const self = this.getWritable();
    self.__count = count;
    return self;
  }

  setVariant(variant: 'a' | 'b'): this {
    const self = this.getWritable();
    self.__variant = variant;
    return self;
  }

  getCount(): number {
    return this.getLatest().__count;
  }

  getVariant(): 'a' | 'b' {
    return this.getLatest().__variant;
  }
}
```

That is the whole of `CounterNode`'s serialization. No `exportJSON`, no
`updateFromJSON`, no `static importJSON`, no `afterCloneFrom`: saying where a
property is stored is what each of those needed to be told.

A property may name accessor methods instead of a field, which is the right
declaration for one the node computes or normalizes rather than stores. That is
the one case a class still writes its own `afterCloneFrom`, since an accessor
names no field for the clone to carry. See [Carrying properties across a
clone](#carrying-properties-across-a-clone).

Each property's schema is built from composable helpers exported by
`lexical`:

- [`stringValue(defaultValue = '')`](/docs/api/modules/lexical#stringvalue), [`numberValue(defaultValue = 0, {min, max, integer, clamp}?)`](/docs/api/modules/lexical#numbervalue), and [`booleanValue(defaultValue = false)`](/docs/api/modules/lexical#booleanvalue) are the primitives. `numberValue` also reads a number spelled as a string (`"120"` reads as `120`), so a document that stringified its numbers keeps them; notations JSON cannot produce (`"0x10"`, `"+1"`, `"Infinity"`) stay out of domain, and the domain it reports is still `number`. A value outside `min`/`max` is out of domain and reads as the default. Pass `clamp` where the bound caps work rather than describes the domain and it reads as the nearest bound instead, as `ListItemNode`'s indent does, since an over-deep item read as `0` would be flattened
- [`enumValue(values, defaultValue?)`](/docs/api/modules/lexical#enumvalue) is one of a fixed set of values. The default is the first unless one is given; a declared `undefined` default is legal only when `undefined` is one of the values
- [`nullable(inner, {defaultAsNull}?)`](/docs/api/modules/lexical#nullable) lets the property also be `null`
- [`optional(inner, {omitDefault}?)`](/docs/api/modules/lexical#optional) lets it be `undefined`
- [`arrayValue(item)`](/docs/api/modules/lexical#arrayvalue) is an array of `item` values. Like `objectValue` it compares by content rather than by reference (see `isEqual` below), so an array equal to its default still compacts away
- [`unionValue(members, defaultValue)`](/docs/api/modules/lexical#unionvalue) picks the member that accepts the value *entirely*, and yields what that member parsed. Only if none does is a member that accepts it partly used, and there the first wins. Declaration order therefore decides between members that fit equally well, not between a complete fit and a partial one: `unionValue([arrayValue(numberValue()), arrayValue(stringValue())])` reads `['red', '42']` as `['red', '42']` rather than letting the first member coerce `'red'` away. A member that normalizes its input behaves the same inside a union as alone, so `unionValue([numberValue(), enumValue(['inherit'])], 'inherit')` reads `"640"` as `640`
- [`transformValue(inner, transform, {isEqual}?)`](/docs/api/modules/lexical#transformvalue) normalizes what `inner` parsed into the stored domain. Introspection still reaches `inner`'s input domain, through a `meta` kind that names the transform. That kind tells a consumer reasoning about the *output* to stop, since the transform is an opaque function: a code generator refuses the property outright. `inner`'s `isEqual` is not inherited, since the transformed domain may be a different type. Pass one only when the output domain is reference-typed, and note that a `unionValue` will not consult it (see below). Over a primitive, a comparator can only declare two distinct serialized values equal, and the compact form then omits whichever is not the default and reads it back as the default: a rotation compared modulo 360 writes nothing for `360` and reads back `0`. Normalize in the `transform` instead. Declaring one over a primitive is an error where it is written
- [`aliasedValue(inner, aliases)`](/docs/api/modules/lexical#aliasedvalue) is a lookup-table normalization. A string matching a key of `aliases` yields the value it names; anything else is `inner`'s to validate, so the domain, the default and the equality stay `inner`'s. This is `transformValue` narrowed to the case where the normalization is a lookup, and it is worth preferring because the lookup is *data*: it goes into the schema's introspectable `meta`, where tooling can read it. Example generation produces the legacy spellings, and a code generator compiles the table instead of being unable to see inside a function. `TextNode` declares its legacy `format: 'bold'` and `detail: 'directionless'` shorthands this way
- [`rawValue()`](/docs/api/modules/lexical#rawvalue) is an escape hatch that passes the value through unparsed
- [`nodeSchema<MyNode>()(fields)`](/docs/api/modules/lexical#nodeschema) is the record of properties, and what `$config`'s `json` takes. Its type argument names the node, which is what lets every `field`, accessor and `when` predicate be checked against it. The two-step call is why both can happen: naming the node explicitly on the same call would stop TypeScript inferring the field types, which are what carry each property's accepted input into `SchemaInput`. See "Names are checked against the node" below. Declare it above the class rather than inline in `$config()`; see "Where to write the schema" below. A property may not be named for a member of `Object.prototype` (`toString`, `constructor`, `valueOf`, `__proto__`, …), which is refused where the schema is written: a serialized object comes from `JSON.parse` and inherits those, and every property is read bare, since an absent one is `undefined` and that is already its default
- [`objectValue(fields)`](/docs/api/modules/lexical#objectvalue) is the same record without the node check, for a property whose value is itself an object. Its fields name no accessor, because an object's field is not a node's property. A node's own schema is always a `nodeSchema`, which is a different type carrying a different `meta`, so `$config`'s `json` refuses an `objectValue` outright rather than composing it to nothing
- [`withAccessors(schema, {getter, setter})`](/docs/api/modules/lexical#withaccessors) names the methods a property is read and applied through, for when they are not the conventional `get<Property>`/`set<Property>`. `text` uses `getTextContent`/`setTextContent`, for example. Pass `null` instead of a name for a direction the property does not have: `{setter: null}` declares a *derived* property, written on export but computed rather than applied on import, as `ListNode`'s `tag` follows from its `listType`; `{getter: null}` declares one parsed but never written. An accessor that cannot be resolved is an error at editor-creation time rather than a silently dropped value, so `null` is how you opt out on purpose. **`withAccessors` and `withField` go outside every other combinator, exactly once per property.** Each combinator widens what the property holds, so an accessor named *under* one answers for a domain that is not the property's. Every combinator refuses a schema that already names an accessor, at compile time and at run time. See the [`withAccessors` API entry](/docs/api/modules/lexical#withaccessors) for the full rule
- [`withField(schema, {field, getter?, setter?, getterTable?, setterTable?, when?})`](/docs/api/modules/lexical#withfield) declares that the property *is* a node field rather than a pair of methods. Exporting reads the field, importing assigns it, with no method call and no version resolution on either side: the node being parsed into is already writable, and the node being exported was already resolved from the EditorState. This is the fast path for a property stored verbatim. The field must be an own property of a fresh node, so initialize it or assign it in the constructor; that is how a misspelled name is told from a real one the first time the node is serialized. Recording the field rather than a bare name is also what lets tooling tell a field from a method, which is enough for a codegen pass to emit a specialized parser.

  Each direction still *stands in for* an accessor. A class that overrides one between the declaring class and the node's own has said the field and the method are not equivalent, and it wins: the field access is abandoned and the method is called, so moving a property to a field is not a behavior change for anyone who overrode its accessor. That accessor is the conventional `get<Prop>`/`set<Prop>` unless `getter`/`setter` name a different one, so most declarations need neither. Name one only where the accessor is spelled differently, as `TextNode`'s `text` is (`getTextContent`) and `LinkNode`'s `url` is (`getURL`). Naming one widens the guard rather than moving it: the conventional name is still watched, because a spelled accessor is usually a wrapper *over* it (`ElementNode`'s `textFormat` names `getSerializedTextFormat`, which computes from `getTextFormat`), and a subclass overriding the accessor that predates the schema must not be ignored. A node with no such method defers to nothing and needs no declaration either.

  `getterTable`/`setterTable` are lookup tables between the stored and serialized forms, as `TextNode` stores `mode` as a number and serializes it as a name. They keep such a property on the direct-field path with no accessor in between. The two directions can also be declared separately: `withAccessors(schema, {getter: {field: '__x'}, setter: 'setX'})` reads the field directly but writes through a method that normalizes.

Each name is checked in the *position* it was written in, not merely for
existing. A getter has to be a method taking no arguments, a setter one that
takes a value, and a `when` predicate a zero-argument method returning
`boolean`, so `getter: 'setStyle'` is a compile error rather than a method the
walk calls with nothing. The *type* behind the name is checked too: the field
has to hold what the schema parses, a getter has to return it (or `undefined`,
which omits the property), and a setter has to accept it.

A field whose stored and serialized forms differ says so with `getterTable`/`setterTable`,
and each table is checked for the one direction it serves. `getterTable`'s values
have to be ones the schema serializes, or `undefined` to omit the property.
`setterTable`'s values have to fit the field, and its keys have to cover everything
the schema produces, since a parsed value the table does not map is stored as
the encoded default. That coverage is checked at compile time for an enum and
at registration for the default of any other schema. A direction with no table
keeps the field's own check.

The result stays bound to one node: `$config` asks for the schema of the class
it is declared on, so a schema checked against an unrelated class is a compile
error there rather than a set of accessors that happen not to resolve at
runtime. One checked against a base class still installs on a subclass, which
is the direction that stays true.

:::caution Name your `extends`

A `$config()` must name its superclass: `this.config('my-node', {extends: MyBase, json: …})`. The runtime has always filled it in from the prototype chain, but the type system cannot, and it is what the composed serialization types follow from one config to the next. Omit it and the node still contributes its own declarations, but the walk stops there, so every property it inherits goes missing from `LexicalSchemaInput` while the runtime keeps applying it. Where the superclass declares a `$config()` of its own, as `TextNode`, `ElementNode` and `LineBreakNode` do, omitting it is now a compile error on the override rather than a silent loss, so a node that used to compile without one needs the single line added.

:::

A schema also carries what it *accepts*, which is wider than what it parses to
wherever it reads more than it writes. `numberValue` reads a number spelled as
a string, `aliasedValue` reads legacy spellings, `optional` reads an absent
property. `SchemaInput<typeof schema>` is that type and
`SerializationSchemaValue<typeof schema>` is the parsed one: for
`aliasedValue(numberValue(), {bold: 1})` they are `number | string | 'bold'`
and `number`.

That difference is why `updateFromJSON` does not constrain the *values* it is
handed. It is the untrusted-JSON boundary and the parser there is total, so
`LexicalParseJSON` keeps the property *names* and types each value as
`unknown`. `node.updateFromJSON({format: 'bold'})` is valid input that a
narrower type rejected while it worked perfectly at runtime, and a misspelled
`frmat` is still an error.

A property that is only persisted in some states names the predicate that
decides, with `when`, rather than going through a hand-written getter:

```ts
textFormat: withAccessors(numberValue(), {
  getter: {
    field: '__textFormat',
    method: 'getSerializedTextFormat',
    when: 'shouldSerializeTextStyles',
  },
}),
```

The property is written only when its value differs from the schema default
*and* the predicate returns true. Testing the default first keeps the predicate
off the common path, so an element with nothing to persist never calls it. The
predicate must be pure and take no arguments: the walk calls it once per
property that names it, while generated code hoists one that several properties
share and calls it once. This is how `ElementNode` persists `textFormat` and
`textStyle` only for an element with no text to derive them from (no
`TextNode` child, and for an inline element such as a link no `TextNode`
anywhere inside it), without either property leaving the direct-field path.

`withField(schema, {field, when})` declares the same for a property that is the
field in both directions. Either way the gate belongs to the export direction,
since there is nothing to gate on the way in: a property that was not written
is simply absent. Naming `when` on a setter is a compile error, like naming the
wrong value table. And like the field read itself, the gate is what the
accessor stands in for: a subclass that overrides that accessor abandons both
the field and the predicate, because a method that replaces the read replaces
the decision to make it.

#### Names are checked against the node

`nodeSchema<MyNode>()` takes one type argument naming the node, and that is
what lets every `field`, accessor `method` and `when` predicate be verified to
exist. A name the node does not have is a compile error at the property that
declares it, with the correction suggested:

```
Type '"field:__langauge"' is not assignable to type '... | TaggedNamesOf<CodeNode> | ObligationsOf<CodeNode>'.
  Did you mean '"field:__language"'?
```

### Where to write the schema

Above the class, as a module-scope `const`, which is what every built-in node
does. Defining it inline with `$config` makes checking that class a cycle,
which TypeScript resolves by switching the check off for it with no diagnostic.
The same is true of a node member whose type is derived from the node's own
`$config()`: an unannotated helper returning `this.$config()`, or one annotated
`toJSON(): LexicalExportJSON<this>`.

The check is TypeScript-only. Under Flow, or from JavaScript, the same mistakes
are caught when the editor registers the node. That is later, but still before
any document is serialized, so nothing depends on the compile-time check being
the only line of defense.

A schema's default is compared by identity, which is right for the primitive
domains. `arrayValue` and `objectValue` return a fresh value per parse, so they
declare an `isEqual` that compares by content; otherwise a property equal to
its default could never be omitted, since no two parses are the same object.
The same rule drives `optional({omitDefault})` and `nullable({defaultAsNull})`,
and a schema of your own can declare `isEqual` for a domain with the same
problem.

A `unionValue` compares structurally rather than asking a member. It picks a
member by what each one *accepts*, and `transformValue` accepts one domain and
produces another, so which member produced a value is not something a union can
recover, and applying the wrong member's comparator is how two different values
get reported as the same one. `arrayValue` and `objectValue` compare
element-wise and field-wise, which is exactly what a union does, so putting
either in a union changes nothing.

A **custom `isEqual` you pass to `transformValue` is not consulted through a
union**: two values it would call equal are reported as different. Such a
property is written out instead of compacted away, `optional({omitDefault})`
around the union keeps it rather than dropping it, and as a `createState` parse
its `NodeState.toJSON()` writes the value, `$getStateChange` reports a change,
and an updater-form `$setState` performs the write. A plain-value `$setState`
never compares, so it is unaffected. The answer is stricter than yours and
never looser, so nothing is lost, and outside a union your comparator is used
as declared. A default is also deeply frozen, since one value is shared by
every node that has none of its own, including as `createState`'s default,
which `$getState` hands back directly.

Parsing is total: a missing or out-of-domain value falls back to the schema's
default instead of throwing, which is the domain importers actually face. Older
documents predate a property, and a compact export omits one whose value is its
default. Each parsed property is applied through the node's setter, either
`set<Property>` or the name given with `withAccessors`, so subclass overrides
are honored, and a subclass schema field with the same serialized property name
overrides its ancestor's.

The same declaration drives the export direction. The base `exportJSON` writes
every declared property, reading each through its getter, so a node needs no
`exportJSON` of its own either. A getter that returns `undefined` omits its
property, since absent and explicitly-`undefined` are indistinguishable once
the JSON is stringified; that is how an optional or conditionally-persisted
property is expressed. Override `exportJSON` only for output a schema cannot
describe, and call `super.exportJSON()` when you do.

Because the node itself declares the schema, tooling can introspect it. The
`@lexical/fast-check` package derives property-based test generators directly
from a node class (`nodeArbitrary(TextNode)`), so one declaration powers both
parsing and example generation in tests.

#### Carrying properties across a clone

A node is cloned on the first write of every update, and a property the clone
does not carry reverts to its constructor default there. Silently, since the
field still exists and still holds a valid value. Declaring a property as a
field says where it is stored, which is also where `afterCloneFrom` comes from:
a class that declares only fields needs none at all, and one that declares some
gets those carried without writing them out again.

```ts
const calloutSchema = nodeSchema<CalloutNode>()({
  label: withField(stringValue(), {field: '__label'}),
});

class CalloutNode extends ElementNode {
  __label: string = '';

  // No afterCloneFrom: `__label` is declared in calloutSchema, so it is
  // carried.
  $config() {
    return this.config('callout', {extends: ElementNode, json: calloutSchema});
  }
}
```

Both directions are read, so a property declared with `withAccessors` in one
direction and a field in the other is still carried, and so is one whose
accessor a subclass overrides. Where a value is *stored* does not change when
the way it is serialized does.

Two cases stay the class's own, and both follow the rule the synthesized
`clone` and `importJSON` follow: declare it yourself and you own it.

- **A property declared through accessor methods on both sides.** The schema
  names no field, so there is nothing to copy, and the class writes an
  `afterCloneFrom` for it. A property whose value does live in one field of the
  node can say so and stay derived, naming the accessor the field stands in for
  (`setter: {field: '__ids', method: 'setIDs'}`, which is how `MarkNode`
  declares `ids`); this is for one whose value does not:

  ```ts
  // Parsed through setCount, written through getCount.
  const tallySchema = nodeSchema<TallyNode>()({count: numberValue()});

  class TallyNode extends ElementNode {
    __count = 0;

    // `count` names no field, so this is the one piece of boilerplate a
    // schema-declared node can still owe.
    afterCloneFrom(prevNode: this): void {
      super.afterCloneFrom(prevNode);
      this.__count = prevNode.__count;
    }

    $config() {
      return this.config('tally', {extends: ElementNode, json: tallySchema});
    }

    setCount(count: number): this {
      const self = this.getWritable();
      self.__count = Math.max(0, count);
      return self;
    }

    getCount(): number {
      return this.getLatest().__count;
    }
  }
  ```
- **A class that defines its own `afterCloneFrom`**, which is left alone and is
  then responsible for all of its own properties. `ElementNode` is one: its
  clone also has to carry `__first`, `__last`, `__size` and its slot
  bookkeeping, none of which any schema describes.

`@lexical/fast-check` is the way to hold a node to this, whichever case it
falls into. See [Generated tests](/docs/packages/lexical-fast-check). A
hand-written fixture tends to leave properties at their defaults, and a dropped
property compares equal to its default, so the bug is invisible exactly when
the test looks like it passed.

### Compact JSON

By default `exportJSON` writes every property, producing the historical
("legacy") format, and a bare `editorState.toJSON()` does too, so existing
persistence pipelines are unaffected until you opt in. With schemas declared,
Lexical can also write a *compact* form, which omits:

- any property whose value is the schema default parsing would restore,
- any property the parser derives rather than reads (declared `{setter: null}`,
  such as `ListNode`'s `tag`),
- the deprecated `version` property.

Which properties those are is the schema's decision, and the same one whichever
implementation writes the document. A property whose default has no comparison
that can be settled ahead of time, meaning a reference-typed default other than
an empty array or one the schema compares with an `isEqual` of its own, is
compared against the schema when the node is exported.

A whole document is written in the compact form by asking for it at the call
site, `editorState.toJSON(true)`, which is also what lets its return type say
which of the two shapes came back: the compact form omits properties, so it is
typed as `CompactSerializedEditorState` rather than `SerializedEditorState`.
Calling `toJSON()` with no argument writes the legacy form, whatever
`$withCompactExport` encloses it, which is what makes that signature true of
what it returns. A nested editor (an image caption) still follows the document
containing it, because `editor.toJSON()` passes the enclosing form on to the
nested `editorState.toJSON` explicitly; its `editorState` is typed as the
compact shape for that reason, since either form may come back.

Anything with a call site of its own should take the form as an argument. The
exception is a schema getter. The walk calls `get<Prop>()` with no arguments,
the contract that lets `getTextContent` and `getURL` be ordinary node methods,
so a getter whose value depends on the form reads `$isCompactExport()` instead.
That reports the surrounding **walk**'s form, which `$withCompactExport`
establishes and `editorState.toJSON(compact)` therefore does too, since it uses
it internally. A node's own `exportJSON(compact)` does not set it, having
already taken the form as an argument.

Parsing restores each, so both forms describe the same document. The compact
form leads each node with `type`, where the legacy form ends with `type` and
`version`; key order is part of neither format, since parsing reads properties
by name. Compaction happens as the properties are written rather than as a
pass over the finished object, so a derived property is skipped without even
calling its getter, and a node with generated serialization code (see below)
inlines the same decisions and never consults the schema at runtime.

Know what the smaller form buys you before reaching for it. The raw JSON is
much smaller, well under half the legacy byte count for a representative rich
document, which matters to consumers of the *objects*: structured clones into
IndexedDB, in-memory copies, messages between workers. After
gzip the two are typically a wash (the omitted properties are exactly the
most repetitive, most compressible bytes; the same benchmark document came
out a few percent *larger* compressed), so compact mode is not a wire-size
optimization for a pipeline that already compresses.

:::caution

The compact form is readable only by a Lexical new enough to parse it, since
the omitted properties are restored from the schema. Persisted documents
outlive the code that wrote them, so keep writing the legacy form until every
reader is upgraded.

:::

An export with no `compact` argument of its own takes its form from an
enclosing `$withCompactExport`. That covers the `@lexical/clipboard` selection
export inside a copy handler, a serialization walk you wrote, and the nested
editors either of those serializes:

```ts
import {$generateJSONFromSelectedNodes} from '@lexical/clipboard';
import {$getSelection, $withCompactExport} from 'lexical';

const selectionJSON = $withCompactExport(true, () =>
  $generateJSONFromSelectedNodes(editor, $getSelection()),
);
```

The callback must be synchronous. The form is restored as soon as it returns,
so an `async` callback would give the form up at its first `await` and export
in whatever form is ambient when it resumes; passing one is a type error at the
call site, and a runtime error in every build.

### Generated serialization code

A schema states everything ahead of time: which accessor or field each
property uses, what its default is, what its domain admits. The serialization
it drives can therefore be compiled to straight-line code instead of
interpreted at runtime. Every built-in node class ships such code, generated
from its own schema at build time and producing byte-identical JSON to the
schema-driven path.

None of this changes how you write a node. It is the same JSON, faster, and a
custom node needs nothing for it, since the schema-driven path serves them. If
you are working on Lexical itself, see
[the generated JSON code](/docs/maintainers-guide#pnpm-run-generate-node-json)
in the maintainers' guide.

### `exportJSON` serializes the version it is called on

`exportJSON` does not resolve the latest version of the node it is called on.
This matters for code that calls `exportJSON` directly on a node reference it
kept across a mutation.

A property declared with `withField` is read straight off the node. That is the
optimization the serialization walk is built on: every node the walk reaches
comes from the `EditorState`'s node map and is already the current version, so
the walk resolves nothing per node. Unlike a property accessor, which resolves
`getLatest()`, it does not bring a stale node reference up to date:

```ts
const stale = node;
node.setStyle('color: red');    // clones; `stale` is now a previous version
stale.exportJSON();             // ← may write the old style
stale.getLatest().exportJSON(); // ← the new one
```

Do not reason about which properties resolve. A property whose accessor a
subclass overrode still goes through that accessor, so a single node can write
a current `text` beside a stale `style` in the same object. Treat the whole
result as "whatever version you called it on" and call `getLatest()` yourself
whenever you hold a reference that may have been superseded.

Nothing inside Lexical needs to: the walk, the `@lexical/clipboard` selection
export and `editorState.toJSON()` all start from the node map, which only ever
holds current versions. This matters only for a node reference you kept across
a mutation and then exported by hand.


### Node structure: `inline`, `children`, `mergeAdjacent`, `derived` {#node-structure}

:::warning Experimental

These keys and `NodeStructureExtension` are experimental.

:::

`$config()` can also state facts about a node's structure: whether it is
inline, what it may hold, and when two adjacent siblings are the same thing.
They do not change serialization. On their own they change nothing at
runtime: the opt-in
[`NodeStructureExtension`](/docs/api/modules/lexical_extension#nodestructureextension)
enforces them, and tools read them with
[`getDeclaredNodeStructure`](/docs/api/modules/lexical#getdeclarednodestructure).

```ts
import {ElementNode, nodeSchema, stringValue, withField} from 'lexical';

const mentionSchema = nodeSchema<MentionNode>()({
  userId: withField(stringValue(), {field: '__userId'}),
});

class MentionNode extends ElementNode {
  __userId = '';

  $config() {
    return this.config('mention', {
      children: 'inline',
      extends: ElementNode,
      inline: true,
      json: mentionSchema,
      // Two adjacent mentions of the same user become one.
      mergeAdjacent: {by: ['userId']},
    });
  }
}
```

- `inline: boolean`: whether a node of the class is inline. A class that
  declares it and does not write its own `isInline()` gets one that returns
  it.
- `children`: what the class may hold. `'inline'` (inline content, like a
  paragraph), `'block'` (blocks, like a table cell), or a list of `'inline'`
  and classes (a list holds list items; a list item holds inline content and
  lists). With the extension, inline content in a node that holds blocks is
  wrapped in a paragraph, and a child a list does not allow is wrapped in the
  first listed class. Inside a block that holds inline content (a quote, a
  list item), a plain paragraph becomes lines of that block: its content is
  joined to its neighbours with line breaks, so a quote holding two
  paragraphs stays one quote, as markdown and HTML import it. Any other block
  (a heading, a code block, a nested quote, a table, a horizontal rule) is
  lifted out and the node is split around it, so the block keeps its type;
  it goes on up until it reaches a node that may hold it. Out of an inline
  element (a link, a mark), the block's inline content, and that of every
  block it holds (list items, table cells), is first wrapped in a copy of the
  element, so its URL or comment ids stay on all of it. A horizontal rule
  in a list item splits the list, wherever it sits in the item, and an
  ordered list's second part starts at the next number. A list item that
  holds a nested list holds nothing else, as indent and HTML import build it:
  next to other content (left by a paste into a nested list item), the
  nested list is lifted out the same way and wrapped in an item of its own,
  so what came before it, the list, and what came after it become
  consecutive items. An update lifts it only out of an item it creates or
  changes; `INTERNAL_$normalizeNodeStructure` lifts it out of every item.
- `mergeAdjacent: {by}`: adjacent siblings of the class whose named schema
  fields (or `StateConfig`s) are equal are the same thing. NodeState counts
  only when named. With the
  extension they are merged, for the class that declares it in its own
  `$config()` only: a subclass that inherits the declaration is merged by its
  own code, so a merge method it overrides (`LinkNode`'s
  `shouldMergeAdjacentLink`, which compares what `by` names) stays the
  authority. `false` turns off a declaration an ancestor made
  (`AutoLinkNode`). Lists merge as `mergeLists` merges them, joining the two
  items that meet when each holds a nested list of one type, but only when
  that list is all each holds, so nothing else in them is removed or moved.
- `derived: true` on a field (`withField(schema, {derived: true, field})` or
  `withAccessors(schema, {derived: true})`) or a state
  (`createState(key, {derived: true, parse})`): the node's own code
  recomputes the value (a list item's `value` and `indent`), so
  `mergeAdjacent` cannot name it, and tools that copy or compare a node's
  data can leave it out. It is still serialized.

To enforce the declarations, add the extension:

```ts
import {
  buildEditorFromExtensions,
  NodeStructureExtension,
} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';

const editor = buildEditorFromExtensions({
  dependencies: [RichTextExtension, NodeStructureExtension],
  name: 'my-editor',
});
```

It normalizes the whole document when it is added (or turned back on), and
then repairs each change in the same update, visiting only what changed. It
only moves content, never deleting it; the one thing it removes is an inline
element left with nothing in it (a link, a mark, the character limit's
`OverflowNode`), which Lexical removes anyway, so that whether something
removed it first never changes the result. Since what did not change is
already normalized, the result depends on the document alone, never on which
nodes changed or in which order their transforms ran. Updates applied with
`skipTransforms` are not normalized: code that applies updates that way calls
the normalization itself. Where it is registered, the link's and
list item's own transforms leave lifting blocks to it, the link's and the
list's leave merging to it, and core's shadow root transform leaves wrapping
inline content in a paragraph to it (it wraps the root's on every update, as
that transform does). Classes that declare
nothing keep whatever they hold, and `isInline()` stays per instance for
classes that compute it. The `OverflowNode` the character limit wraps around
overflowing text is allowed anywhere, so it stays in its paragraph although
its `isInline()` is false. Each editor enforces its own registration: a
nested editor (an image caption) needs the extension too. For an editor
built without extensions, `registerNodeStructure(editor)` does the same.

Where the declarations are enforced (the extension, `registerNodeStructure`,
or a `@lexical/y` binding, which always enforces them), a class that
declares `children: 'block'` (a callout, a box) is also a block container
for the structural commands, as the root and shadow roots are: turning one
of its paragraphs into a list (`$insertList`, or a markdown shortcut),
wrapping it (`$wrapNodes`), pasting several blocks into it (`insertNodes`),
inserting a block such as a table or a horizontal rule
(`$insertNodeToNearestRoot`), or pressing Enter in an empty list item acts
on the blocks inside it and keeps the container, where otherwise the
container itself would be replaced, split or left. Converting a block's type
(`$setBlocksType`) and indenting already act on the block in place in any
container; with the selection in an empty container, `$setBlocksType` puts
the new block in it. Unlike a shadow root
(`isShadowRoot()`), a declared container is not a selection boundary:
select-all, the arrow keys, and Backspace or Delete at its edges treat it
like any other element, so Backspace at the start of its first paragraph
still joins that paragraph to the block before the container.
[`$isBlockContainer(node)`](/docs/api/modules/lexical#isblockcontainer)
tells whether a node is one. A container that declares nothing keeps the
usual behavior, where `$insertList` replaces the whole container with the
list; but if it also holds a block a list item cannot hold (a quote,
another box), the paragraph (or heading, or quote) holding the selected
text becomes a list in place, inside the container, instead of the list
being dropped.

```ts
class CalloutNode extends ElementNode {
  $config() {
    return this.config('callout', {children: 'block', extends: ElementNode});
  }
}
```

Each key is inherited by subclasses that do not declare it. In development,
the keys a class declares in its own `$config()` are checked when an editor
is created: `by` must name known, non-derived values, a declared `inline`
must agree with an overridden `isInline()`, and a merging class that lists
child classes must list classes that hold inline content. Inherited
declarations are never refused: where a subclass contradicts one, or may (a
`LinkNode` subclass whose `isInline()` returns `false`, or reads instance
state; a `mergeAdjacent` whose `by` does not fit it), the key reads as
undeclared for that subclass.

Tools read the declarations with
[`getDeclaredNodeStructure(klass)`](/docs/api/modules/lexical#getdeclarednodestructure),
which also lists the values a class declares `derived`.

### Versioning & Breaking Changes

Serialized documents outlive the code that wrote them, so avoid breaking
changes to a node's existing JSON properties. Evolve the schema additively
instead: add a new property with a default, and documents written before it
existed parse with that default.

```ts
const calloutSchema = nodeSchema<CalloutNode>()({
  label: withField(stringValue(), {field: '__label'}),
  // Added later. Older documents have no `tone`, so it parses as 'info'.
  tone: withField(enumValue(['info', 'warning']), {field: '__tone'}),
});
```

Don't remove or change the meaning of an existing property, as this can
corrupt existing documents. If the representation has to change
incompatibly, it's usually best to register a new node type.

Lexical's own `version` property is deprecated and is not the way to do this:
nothing reads it, parsing drops it, and a compact export omits it. See
[Dangers of a flat version property](./legacy.md#dangers-of-a-flat-version-property)
for why.

## HTML

HTML is mostly used to exchange content with other applications, such as
copying and pasting between Lexical and Google Docs, and to render a document
outside the editor. Both directions are in
[`@lexical/html`](/docs/packages/lexical-html), and both are configured with
extensions: [`DOMRenderExtension`](./dom-render.md) for export and
[`DOMImportExtension`](./dom-import.md) for import.

### Lexical -> HTML

When generating HTML from an editor you can pass in a selection object to
narrow it down to a certain section, or pass in `null` to convert the whole
editor:

```js
import {$generateHtmlFromNodes} from '@lexical/html';

const htmlString = editor.read(() => $generateHtmlFromNodes(editor, null));
```

By default a node exports the same element that its `createDOM()` renders in
the editor. To change that without subclassing, add a `$exportDOM` override
with `DOMRenderExtension`. Each override calls `$next()` to get the default
result and adjusts it, so overrides from several extensions compose:

```ts
import {configExtension, defineExtension} from '@lexical/extension';
import {DOMRenderExtension, domOverride} from '@lexical/html';
import {ParagraphNode, isHTMLElement} from 'lexical';

// Adds a class to every exported paragraph
const ExportClassesExtension = defineExtension({
  dependencies: [
    configExtension(DOMRenderExtension, {
      overrides: [
        domOverride([ParagraphNode], {
          $exportDOM(_node, $next) {
            const output = $next();
            if (isHTMLElement(output.element)) {
              output.element.classList.add('exported');
            }
            return output;
          },
        }),
      ],
    }),
  ],
  name: '@my-app/ExportClasses',
});
```

`$exportDOM` overrides only affect export. The same extension can also
override how nodes render inside the editor, and only part of that carries
through to export:

- A `$createDOM` override also changes the export of nodes that use the
  default `exportDOM` (or call `super.exportDOM()`), such as `TextNode` and
  `ParagraphNode`, since that default builds its element with the editor's
  `$createDOM`. A node class whose `exportDOM` creates its own element skips
  it, so use `$exportDOM` for that node.
- `$updateDOM` and `$decorateDOM` run only while the editor reconciles its
  DOM, so anything they add appears in the editor but not in exported HTML.
  Add it with `$exportDOM` too if the export needs it.

See [DOMRenderExtension](./dom-render.md) for everything it can override.

### HTML -> Lexical

The node extensions (`RichTextExtension`, `ListExtension`, `LinkExtension`,
`TableExtension`, `CodeExtension` and others) register import rules for
their nodes with `DOMImportExtension`, so an editor built from them already
knows how to import their HTML. Parse the HTML into a DOM and convert it
with `$generateNodesFromDOMViaExtension`:

```js
import {$generateNodesFromDOMViaExtension} from '@lexical/html';
import {$getRoot, $insertNodes} from 'lexical';

editor.update(() => {
  // In the browser you can use the native DOMParser API to parse the HTML string.
  const dom = new DOMParser().parseFromString(htmlString, 'text/html');

  // Once you have the DOM instance it's easy to generate LexicalNodes.
  const nodes = $generateNodesFromDOMViaExtension(dom);

  // Replace the document with the imported nodes. To insert them at the
  // current selection instead, call $insertNodes(nodes) on its own.
  $getRoot().clear().select();
  $insertNodes(nodes);
});
```

Outside a browser, build an editor with the same extensions (so it has the
same nodes and import rules) and run the import inside `withDOM()` from
`@lexical/headless/dom`, which provides a temporary happy-dom window. See
[Running Without a Browser](../concepts/headless.md).

```js
import {buildEditorFromExtensions} from '@lexical/extension';
import {HeadlessExtension} from '@lexical/headless';
import {withDOM} from '@lexical/headless/dom';
import {$generateNodesFromDOMViaExtension} from '@lexical/html';
import {RichTextExtension} from '@lexical/rich-text';
import {$getRoot, $insertNodes, defineExtension} from 'lexical';

const editor = buildEditorFromExtensions(
  defineExtension({
    // Use the same extensions (and so the same nodes) as your editor
    dependencies: [HeadlessExtension, RichTextExtension],
    name: '@my-app/server-editor',
  }),
);

withDOM((window) => {
  const dom = new window.DOMParser().parseFromString(htmlString, 'text/html');
  editor.update(
    () => {
      const nodes = $generateNodesFromDOMViaExtension(dom);
      $getRoot().clear().select();
      $insertNodes(nodes);
    },
    {discrete: true},
  );
});
```

:::tip

Remember that state updates are asynchronous, so executing `editor.getEditorState()` immediately afterwards might not return the expected content. To avoid it, [pass `discrete: true` in the `editor.update` method](../concepts/editor-state.md#synchronous-reconciliation-with-discrete-updates).

:::

To route pasted HTML through the same rules, add
[`ClipboardDOMImportExtension`](./dom-import.md#routing-pastes-through-domimportextension)
from `@lexical/clipboard` to your editor. [DOMImportExtension](./dom-import.md)
covers writing your own rules, selectors, and the other options.

### Handling extended HTML styling

`TextNode` stores inline CSS in its `style` property, and exports it as the
`style` attribute of the element it renders. Import is more selective: the
default rules turn formatting such as bold or italic into text formats, but
don't copy arbitrary inline CSS such as `color` or `font-size` onto the
imported text. To keep those styles, add an import rule that matches any
element with a `style` attribute, lets the other rules import it with
`$next()`, and then adds the element's styles to the text it produced:

```ts
import {configExtension, defineExtension} from '@lexical/extension';
import {DOMImportExtension, defineImportRule, sel} from '@lexical/html';
import {getCSSFromStyleObject} from '@lexical/selection';
import {
  $isElementNode,
  $isTextNode,
  getStyleObjectFromCSS,
  type LexicalNode,
} from 'lexical';

// The inline styles to keep on imported text
const IMPORTED_STYLES = [
  'background-color',
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'text-decoration',
];

function $applyStyles(
  nodes: LexicalNode[],
  styles: Record<string, string>,
): void {
  for (const node of nodes) {
    if ($isTextNode(node)) {
      // Styles already on the node came from an element closer to the
      // text, so they take precedence.
      node.setStyle(
        getCSSFromStyleObject({
          ...styles,
          ...getStyleObjectFromCSS(node.getStyle()),
        }),
      );
    } else if ($isElementNode(node)) {
      // Such as the text inside an imported link
      $applyStyles(node.getChildren(), styles);
    }
  }
}

const ExtendedStyleImportRule = defineImportRule({
  $import(_ctx, el, $next) {
    const nodes = $next();
    const elementStyles = getStyleObjectFromCSS(el.getAttribute('style') || '');
    const styles: Record<string, string> = {};
    for (const property of IMPORTED_STYLES) {
      if (elementStyles[property]) {
        styles[property] = elementStyles[property];
      }
    }
    if (Object.keys(styles).length > 0) {
      $applyStyles(nodes, styles);
    }
    return nodes;
  },
  match: sel.any().attr('style', /\S/),
  name: '@my-app/extended-styles',
});

export const ExtendedStylesExtension = defineExtension({
  dependencies: [
    configExtension(DOMImportExtension, {rules: [ExtendedStyleImportRule]}),
  ],
  name: '@my-app/ExtendedStyles',
});
```

Add `ExtendedStylesExtension` to your editor's `dependencies` alongside the
extensions it already uses. Rules from a dependent extension take priority, so
this rule sees every styled element first, and `$next()` hands it on to the
rule that would have imported it anyway. With it,
`<span style="color: red; margin: 4px">red</span>` imports as a `TextNode`
with the style `color: red;`, and exporting it again writes that style back
out. Nothing has to replace `TextNode`, and no JSON changes, since `style` is
already one of its properties.
