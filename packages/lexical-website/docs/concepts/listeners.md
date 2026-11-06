

# Listeners

Listeners are a mechanism that lets the Editor instance inform the user when a certain operation has occurred. All listeners follow a reactive pattern where you can do an operation upon something happening in the future. All listeners also return a function that easily allows for the
listener to be unregistered. Below are the different listeners that Lexical supports today:

## `registerUpdateListener`

Get notified when Lexical commits an update to the DOM.

```js
const removeUpdateListener = editor.registerUpdateListener(({editorState}) => {
  // The latest EditorState can be found as `editorState`.
  // To read the contents of the EditorState, use the following API:

  editorState.read(() => {
    // Just like editor.update(), .read() expects a closure where you can use
    // the $ prefixed helper functions.
  });
});

// Do not forget to unregister the listener when no longer needed!
removeUpdateListener();
```

The update listener callbacks receives a single argument containing the follow properties:

- `editorState` the latest updated Editor State
- `prevEditorState` the previous Editor State
- `tags` a Set of all tags that were passed to the update
- `dirtyElements` a Map of the NodeKeys of ElementNodes that were marked
  dirty, to a boolean that is true when the node was intentionally mutated
- `dirtyLeaves` a Set of the NodeKeys of all dirty nodes that are not
  ElementNodes
- `mutatedNodes` a Map of LexicalNode constructors to a
  `Map<NodeKey, NodeMutation>`, or null when no DOM was mutated. Only
  populated when at least one MutationListener is registered
- `normalizedNodes` (advanced) the keys of TextNode descendants that were
  merged with a sibling by normalization

One thing to be aware of is "waterfall" updates. This is where you might schedule an update inside an update
listener, as shown below:

```js
editor.registerUpdateListener(({editorState}) => {
  // Read the editorState and maybe get some value.
  editorState.read(() => {
    // ...
  });

  // Then schedule another update.
  editor.update(() => {
    // ...
  });
});
```

The problem with this pattern is that it means we end up doing two DOM updates, when we likely could have
done it in a single DOM update. This can have an impact on performance, which is important in a text editor.

A listener that re-enqueues work without a stop condition is worse than slow.
The editor keeps a cascade budget: once a run of updates re-enqueues more
than 100 times without yielding to the event loop, it discards the entire
pending update queue and warns. Bounded activity never reaches the limit —
the budget is reset from a macrotask, which a genuine runaway starves — but a
true loop silently loses whatever else was queued.

To avoid this, we recommend looking into [Node Transforms](transforms.md), which allow you to listen to node changes and
transform them as part of the same given update, meaning no waterfalls!

## `registerTextContentListener`

Get notified when Lexical commits an update to the DOM and the text content of the editor changes from
the previous state of the editor. If the text content is the same between updates, no notifications to
the listeners will happen.

```js
const removeTextContentListener = editor.registerTextContentListener(
  (textContent) => {
    // The latest text content of the editor!
    console.log(textContent);
  },
);

// Do not forget to unregister the listener when no longer needed!
removeTextContentListener();
```

## `registerMutationListener`

Get notified when a specific type of Lexical node has been mutated. There are three states of mutation:

- `created`
- `destroyed`
- `updated`

Mutation listeners are great for tracking the lifecycle of specific types of node. They can be used to
handle external UI state and UI features relating to specific types of node.

If any existing nodes are in the DOM, and skipInitialization is not true, the listener
will be called immediately with an updateTag of 'registerMutationListener' where all
nodes have the 'created' NodeMutation. This can be controlled with the skipInitialization option,
which defaults to false.

```js
const removeMutationListener = editor.registerMutationListener(
  MyCustomNode,
  (mutatedNodes, { updateTags, dirtyLeaves, prevEditorState }) => {
    // mutatedNodes is a Map where each key is the NodeKey, and the value is the state of mutation.
    for (let [nodeKey, mutation] of mutatedNodes) {
      console.log(nodeKey, mutation)
    }
  },
  {skipInitialization: false}
);

// Do not forget to unregister the listener when no longer needed!
removeMutationListener();
```

## `registerEditableListener`

Get notified when the editor's mode has changed. The editor's mode can be changed
via `editor.setEditable(boolean)`.

```js
const removeEditableListener = editor.registerEditableListener(
  (editable) => {
    // The editor's mode is passed in!
    console.log(editable);
  },
);

// Do not forget to unregister the listener when no longer needed!
removeEditableListener();
```

## `registerDecoratorListener`

Get notified when the editor's decorator object changes. The decorator object contains
all `DecoratorNode` keys -> their decorated value. This is primarily used with external
UI frameworks.

```js
const removeDecoratorListener = editor.registerDecoratorListener(
  (decorators) => {
    // The editor's decorators object is passed in!
    console.log(decorators);
  },
);

// Do not forget to unregister the listener when no longer needed!
removeDecoratorListener();
```

## `registerRootListener`

Get notified when the editor's root DOM element (the content editable Lexical attaches to) changes. This is primarily used to
attach event listeners to the root element. *The root listener function is executed directly upon registration and then on any subsequent update.*

```js
const removeRootListener = editor.registerRootListener(
  (rootElement, prevRootElement) => {
   //add listeners to the new root element
   //remove listeners from the old root element
  },
);

// Do not forget to unregister the listener when no longer needed!
removeRootListener();
```
