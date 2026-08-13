# `@lexical/history`

[![See API Documentation](https://lexical.dev/img/see-api-documentation.svg)](https://lexical.dev/docs/api/modules/lexical_history)

This package contains history helpers for Lexical.

### Methods

#### `registerHistory`

Registers necessary listeners to manage undo/redo history stack and related editor commands. It returns `unregister` callback that cleans up all listeners and should be called on editor unmount.

```js
function registerHistory(
  editor: LexicalEditor,
  externalHistoryState: HistoryState,
  delay: number,
): () => void
```

### Commands

History package handles `UNDO_COMMAND`, `REDO_COMMAND` and `CLEAR_HISTORY_COMMAND` commands. These commands could be used to work with history state:

```jsx
import {UNDO_COMMAND, REDO_COMMAND} from 'lexical';

<Toolbar>
  <Button onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)}>Undo</Button>
  <Button onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)}>Redo</Button>
</Toolbar>;
```

### Undo/redo availability

`CAN_UNDO_COMMAND` and `CAN_REDO_COMMAND` are **deprecated**. A command only reports a change, so a listener registered after the editor is initialized never sees the current value, and there is no way to read it.

Use the `canUndo` and `canRedo` signals from `HistoryExtension` instead. They are derived from the history stacks and always hold the current value:

In React, use the `useExtensionSignalValue` hook:

```jsx
import {HistoryExtension} from '@lexical/history';
import {useExtensionSignalValue} from '@lexical/react/useExtensionSignalValue';

function UndoButton() {
  const canUndo = useExtensionSignalValue(HistoryExtension, 'canUndo');
  return <Button disabled={!canUndo}>Undo</Button>;
}
```

Outside React, read the signal directly:

```js
import {getExtensionDependencyFromEditor} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';

const {output} = getExtensionDependencyFromEditor(editor, HistoryExtension);
output.canUndo.peek();
```
