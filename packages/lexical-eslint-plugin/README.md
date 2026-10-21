# `@lexical/eslint-plugin`

This ESLint plugin enforces the [Lexical $function convention](https://lexical.dev/docs/intro#reading-and-updating-editor-state).

**ESLint Compatibility:** This plugin supports ESLint 9 and later with the flat config format (`eslint.config.js`). Support for ESLint 7-8 and the legacy `.eslintrc` format was removed in v0.51.0.

## Installation

Assuming you already have ESLint installed, run:

```sh
npm install @lexical/eslint-plugin --save-dev
```

### Configuration

Add the recommended config to your `eslint.config.js`:

```js
import lexical from '@lexical/eslint-plugin';

export default [
  // ... other configs
  lexical.configs.recommended
];
```

`lexical.configs['flat/recommended']` and `lexical.configs['flat/all']` are
aliases of `recommended` and `all` from when those names were the legacy
configs. The default presets enable `@lexical/rules-of-lexical` and
`@lexical/no-nested-editor-updates` as warnings.
`@lexical/no-document-in-dom-methods` remains opt-in because it is specific
to Lexical DOM method implementations.

### Custom Configuration

```js
import lexical from '@lexical/eslint-plugin';

export default [
  {
    plugins: {
      '@lexical': lexical
    },
    rules: {
      '@lexical/rules-of-lexical': 'error'
    }
  }
];
```

### Preventing nested editor updates

`@lexical/no-nested-editor-updates` reports same-editor `update()` calls
directly inside `update`, `registerCommand`, or `registerNodeTransform`
callbacks. The receivers must match by expression and identifier binding;
updates to a different editor, such as `childEditor.update(...)`, are valid.
The default presets enable the rule as a warning; set it to `error` or `off`
in your flat configuration's `rules` object to change that severity.

Command listeners already provide an update context. Remove a nested
`editor.update()` wrapper and perform the mutation directly:

```js
editor.registerCommand(
  REMOVE_NODE_COMMAND,
  () => {
    $getSelection().removeText();
    return true;
  },
  COMMAND_PRIORITY_EDITOR,
);
```

Inside `editor.read(callback)` or `editor.read(mode, callback)`, the context
is read-only. Move the intact update after the read instead of removing its
wrapper:

```js
const shouldRemove = editor.read('latest', () => {
  return $getSelection()?.isCollapsed() === false;
});

if (shouldRemove) {
  editor.update(() => {
    $getSelection()?.removeText();
  });
}
```

An update directly inside a $function receives separate guidance: remove the
wrapper if the function uses the active editor context, or remove the `$`
prefix if the function intentionally owns the update.

For a statically analyzable options object, preserve `tag` with `$addUpdateTag`
(once per value for an array), `discrete` with `$flushSyncAfterUpdate`, and
`onUpdate` with `$onUpdate` before removing the wrapper. Preserve conditional
option values: call `$flushSyncAfterUpdate()` only when `discrete` is true.
`skipTransforms` has no in-place equivalent, so objects containing it, opaque
identifiers, spreads, computed properties, and unknown properties are left
alone. Updates inside `read()` retain all options when moved after the read.

By default, editor expressions must end in `editor`, ignoring case. This
recognizes `editor`, `childEditor`, `props.editor`, `$getEditor()`, and
`this.editor`. The last expression matches across arrow callbacks, where
`this` is lexical, but not ordinary function callbacks. Inside $functions,
only `editor` and `$getEditor()` are assumed to be the active editor.

Use `isEditor` to add names or patterns, and `isDollarFunction` to extend
the default `/^\$[a-z_]/` function-name matcher:

```js
const rules = {
  '@lexical/no-nested-editor-updates': [
    'error',
    {
      isDollarFunction: '^INTERNAL_\\$',
      isEditor: ['^lexicalInstance$', '^getMyEditor$'],
    },
  ],
};
```

Repeated configured zero-argument accessors such as `getMyEditor()` match as
the same editor expression. The analysis does not follow callbacks passed by
reference, aliases between differently named editor variables, or another
nested callback such as `setTimeout(() => editor.update(...))`. There is no
autofix.


### Advanced configuration

Most of the heuristics in `@lexical/rules-of-lexical` can be extended with
additional terms or patterns.

The code example below is shown using the default implementations for each
option. When you configure these they are combined with the default
implementations using "OR", the default implementations can not be overridden.
These terms and patterns are only shown for reference and pasting this example
into your project is not useful.

If the string begins with a `"^"` or `"("` then it is treated as a RegExp,
otherwise it will be an exact match. A string may also be used instead
of an array of strings.

```js
import lexical from '@lexical/eslint-plugin';

export default [
  {
    plugins: {
      '@lexical': lexical
    },
    rules: {
      '@lexical/rules-of-lexical': [
        'error',
        {
          isDollarFunction: ['^\\$[a-z_]'],
          isIgnoredFunction: [],
          isLexicalProvider: [
            'parseEditorState',
            'read',
            'registerCommand',
            'registerNodeTransform',
            'update'
          ],
          isSafeDollarFunction: ['^\\$is']
        }
      ]
    }
  }
];
```

#### `isDollarFunction`

*Base case*: `/^\$[a-z_]/`

This defines the \$function convention, which by default is any function that
starts with a dollar sign followed by a lowercase latin letter. You may have a
secondary convention in your codebase, such as non-latin letters, or an
internal prefix that you want to consider (e.g. `"^INTERNAL_\\$"`).

#### `isIgnoredFunction`

*Base case*: None

Functions that match these patterns are ignored from analysis, they may call
Lexical \$functions but are not considered to be a dollar function themselves.

#### `isLexicalProvider`

*Base case*: `/^(parseEditorState|read|registerCommand|registerNodeTransform|update)$/`

These are functions that allow their function argument to use Lexical
\$functions.

#### `isSafeDollarFunction`

*Base case*: `/^\$is/`

These \$functions are considered safe to call from anywhere, generally
these functions are runtime type checks that do not depend on any other
state.

## Testing

To verify that the plugin works with different ESLint versions, run the integration tests:

```bash
pnpm run test-eslint-integration
```

This will test:
- ✓ ESLint 9 with a flat `eslint.config.js` configuration
- ✓ ESLint 10 with the same configuration

The tests use `pnpm dlx` to run different ESLint versions without modifying `package.json` or `pnpm-lock.yaml`.

## Valid and Invalid Examples

### Valid Examples

\$functions may be called by other \$functions

```js
function $namedCorrectly() {
  return $getRoot();
}
```

\$functions may be called in functions defined when calling the following
methods (the heuristic only considers the method name):

* `editor.update`
* `editorState.read`
* `editor.registerCommand`
* `editor.registerNodeTransform`

```js
function validUsesEditorOrState(editor) {
  editor.update(() => $getRoot());
  editor.getLatestState().read(() => $getRoot());
}
```

\$functions may be called from class methods

```js
class CustomNode extends ElementNode {
  appendText(string) {
    this.appendChild($createTextNode(string));
  }
}
```

### Invalid Examples

#### Rename autofix

```js
function invalidFunction() {
  return $getRoot();
}
function $callsInvalidFunction() {
  return invalidFunction();
}
```

*Autofix:* The function is renamed with a $ prefix. Any references to this
name in this module are also always renamed.

```js
function $invalidFunction() {
  return $getRoot();
}
function $callsInvalidFunction() {
  return $invalidFunction();
}
```

#### Rename & deprecate autofix

```js
export function exportedInvalidFunction() {
  return $getRoot();
}
```

*Autofix:* The exported function is renamed with a $ prefix. The previous name
is also exported and marked deprecated, because automatic renaming of
references to that name is limited to the module's scope.

```js
export function $exportedInvalidFunction() {
  return $getRoot();
}
/** @deprecated renamed to {@link $exportedInvalidFunction} by @lexical/eslint-plugin rules-of-lexical */
export const exportedInvalidFunction = $exportedInvalidFunction;
```

#### Rename scope conflict

```js
import {$getRoot} from 'lexical';
function InvalidComponent() {
  const [editor] = useLexicalComposerContext();
  const getRoot = useCallback(() => $getRoot(), []);
  return (<button onClick={() => editor.update(() => getRoot())} />);
}
```

*Autofix:* The function is renamed with a $ prefix and _ suffix since the suggested name was already in scope.

```js
import {$getRoot} from 'lexical';
function InvalidComponent() {
  const [editor] = useLexicalComposerContext();
  const $getRoot_ = useCallback(() => $getRoot(), []);
  return (<button onClick={() => editor.update(() => $getRoot_())} />);
}
```
