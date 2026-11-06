

# Working with DOM Events

Sometimes, when working with Lexical, it might be necessary or useful for you to attach a DOM Event Listener to the underlying DOM nodes that Lexical controls. For instance, you might want to show a popover when a user mouses over a specific node or open a modal when they click on a node. Either of these use cases (and many others) can be accomplished via native DOM Event Listeners. There are 3 main ways that you can listen for DOM Events on nodes controlled by Lexical:

## 1. Event Delegation

One way to handle events inside the editor is to set a listener on the editor root element (the contentEditable Lexical attaches to). You can do this using a [Root Listener](listeners.md).

```js
function myListener(event) {
    // You may want to filter on the event target here
    // to only include clicks on certain types of DOM Nodes.
    alert('Nice!');
}

const ClickExtension = defineExtension({
  name: '@my-app/Click',
  register: (editor) =>
    editor.registerRootListener((rootElement) => {
      if (rootElement === null) {
        return;
      }
      // add the listener to the current root element
      rootElement.addEventListener('click', myListener);
      // remove the listener when the root element changes - make sure the ref
      // to myListener is stable so the removal works and you avoid a memory leak.
      return () => rootElement.removeEventListener('click', myListener);
    }),
});
```

An extension's `register` returns a cleanup function, and the editor calls it
when it is disposed, so there is no teardown to write by hand. Add
`ClickExtension` to your editor's `dependencies` to use it.
This can be a simple, efficient way to handle some use cases, since it's not necessary to attach a listener to each DOM node individually.

The `addEventListener`/`removeEventListener` pairing above is common enough that the core `lexical` package exports a `registerEventListener(target, type, listener, options?)` helper. It attaches the listener and returns a dispose function that removes it, so the example above becomes:

```js
import {defineExtension, registerEventListener} from 'lexical';

const ClickExtension = defineExtension({
  name: '@my-app/Click',
  register: (editor) =>
    editor.registerRootListener((rootElement) =>
      // registerEventListener returns the matching removeEventListener cleanup,
      // so there's no need to write the teardown by hand.
      rootElement === null
        ? undefined
        : registerEventListener(rootElement, 'click', myListener),
    ),
});
```

It mirrors the `addEventListener` overloads (so the event type is strongly typed) and composes well with `mergeRegister` when you need to register several listeners at once.

To attach several listeners to the same target, `registerEventListeners(target, listeners, options?)` takes a `{type: listener}` map and returns a single dispose function that removes all of them. Each listener's event argument is still strongly typed per event type, and the optional `options` argument is shared across every listener:

```js
import {registerEventListeners} from 'lexical';

const removeListeners = registerEventListeners(
  rootElement,
  {
    click: onClick,
    keydown: onKeyDown, // receives a KeyboardEvent
  },
  {capture: true}, // shared by both listeners
);
```

Because `options` is shared, register a group that needs different options (such as a different `capture` flag) with a separate `registerEventListeners` call and combine the results with `mergeRegister`.

## 2. Directly Attach Handlers

In some cases, it may be better to attach an event handler directly to the underlying DOM node of each specific node. With this approach, you generally don't need to filter the event target in the handler, which can make it a bit simpler. It will also guarantee that your handler isn't running for events that you don't care about. This approach is implemented via a [Mutation Listener](listeners.md).

```js
const registeredElements: WeakSet<HTMLElement> = new WeakSet();
const removeMutationListener = editor.registerMutationListener(nodeType, (mutations) => {
    editor.getEditorState().read(() => {
        for (const [key, mutation] of mutations) {
            const element: null | HTMLElement = editor.getElementByKey(key);
            if (
                // Updated might be a move, so that might mean a new DOM element
                // is created. In this case, we need to add an event listener too.
                (mutation === 'created' || mutation === 'updated') &&
                element !== null &&
                !registeredElements.has(element)
            ) {
                registeredElements.add(element);
                element.addEventListener('click', (event: Event) => {
                    alert('Nice!');
                });
            }
        }
    });
});

// teardown the listener - return it from an extension's `register` so the
// editor removes it when it is disposed.
removeMutationListener();
```
Notice that here we don't worry about cleaning up, as Lexical will dereference the underlying DOM nodes and allow the JavaScript runtime garbage collector to clean up their listeners.

## 3. Use NodeEventPlugin

If you're using React, we've wrapped approach #2 up into a simple React plugin that you can render inside your composer to achieve the same effect, without worrying about the details:

```jsx
<LexicalExtensionComposer extension={appExtension}>
    <NodeEventPlugin
        nodeType={LinkNode}
        eventType={'click'}
        eventListener={(e: Event) => {
            alert('Nice!');
        }}
    />
</LexicalExtensionComposer>
```

If the editor lives inside a shadow root or an iframe, see
[Shadow DOM and iframes](./shadow-dom.md) for the helper to read
`event.target` through the shadow boundary — the browser retargets it to the
shadow host on listeners attached above the boundary, so a plain
`event.target` won't match a node inside the editor.
