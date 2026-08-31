/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {RuleTester} from 'eslint';
import {describe, expect, it} from 'vitest';

import plugin from '../../LexicalEslintPlugin.js';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2018,
    sourceType: 'module',
  },
});

const rule = plugin.rules['no-nested-editor-updates'];

describe('no-nested-editor-updates', () => {
  it('reports ambiguous $function ownership without flagging child editors', () => {
    ruleTester.run('$functions', rule, {
      invalid: [
        {
          code: `function $updateSomething(editor) {
  editor.update(() => {});
}`,
          errors: [
            {
              data: {
                callee: 'editor.update',
                context: '$updateSomething',
              },
              messageId: 'dollarFunctionUpdate',
            },
          ],
        },
        {
          code: `const $updateSomething = useCallback(() => {
  editor.update(() => {});
}, [editor]);`,
          errors: [{messageId: 'dollarFunctionUpdate'}],
        },
        {
          code: `function $updateSomething() {
  $getEditor().update(() => {});
}`,
          errors: [{messageId: 'dollarFunctionUpdate'}],
        },
        {
          code: `function $updateSomething(editor) {
  editor.update(() => {}, {discrete: true});
}`,
          errors: [
            {
              data: {
                callee: 'editor.update',
                context: '$updateSomething',
                migrations: '`discrete` with `$flushSyncAfterUpdate`',
              },
              messageId: 'dollarFunctionUpdateWithOptions',
            },
          ],
        },
      ],
      valid: [
        `function updateSomething(editor) {
  editor.update(() => {});
}`,
        `function $updateSomething(session) {
  session.update(() => {});
}`,
        `function $syncChild(childEditor) {
  childEditor.update(() => {});
}`,
        `function $updateSomething(nestedEditor) {
  nestedEditor.update(() => {});
}`,
        `function $updateSomething(props) {
  props.editor.update(() => {});
}`,
        `function $updateSomething(editor) {
  setTimeout(() => editor.update(() => {}), 0);
}`,
        `function $updateSomething(editor) {
  editor.update(() => {}, {skipTransforms: true});
}`,
        `function $updateSomething(editor, updateOptions) {
  editor.update(() => {}, updateOptions);
}`,
      ],
    });
  });

  it('reports nested updates only when the receiver binding is the same', () => {
    ruleTester.run('implicit update callbacks', rule, {
      invalid: [
        {
          code: `editor.update(() => {
  editor.update(() => {});
});`,
          errors: [
            {
              data: {
                callee: 'editor.update',
                context: 'editor.update callback',
              },
              messageId: 'noNestedEditorUpdates',
            },
          ],
        },
        {
          code: `editor.update(() => {
  editor.update(() => {}, {
    tag: ['a', 'b'],
    discrete: true,
    onUpdate() {},
  });
});`,
          errors: [
            {
              data: {
                callee: 'editor.update',
                context: 'editor.update callback',
                migrations:
                  '`tag` with `$addUpdateTag`, `discrete` with `$flushSyncAfterUpdate`, and `onUpdate` with `$onUpdate`',
              },
              messageId: 'noNestedEditorUpdatesWithOptions',
            },
          ],
        },
        {
          code: `editor.update(() => {
  editor.update(() => {}, {});
});`,
          errors: [{messageId: 'noNestedEditorUpdates'}],
        },
        {
          code: `const editor = getEditor();
editor.registerCommand(COMMAND, () => {
  editor.update(() => {});
}, PRIORITY);`,
          errors: [
            {
              data: {
                callee: 'editor.update',
                context: 'editor.registerCommand callback',
              },
              messageId: 'noNestedEditorUpdates',
            },
          ],
        },
        {
          code: `editor.registerNodeTransform(Node, () => {
  editor.update(() => {});
});`,
          errors: [{messageId: 'noNestedEditorUpdates'}],
        },
        {
          code: `editor.read(() => {
  editor.update(() => {});
});`,
          errors: [
            {
              data: {
                callee: 'editor.update',
                context: 'editor.read callback',
              },
              messageId: 'readOnlyUpdate',
            },
          ],
        },
        {
          code: `editor.read('latest', () => {
  editor.update(() => {});
});`,
          errors: [{messageId: 'readOnlyUpdate'}],
        },
        {
          code: `editor.read(() => {
  editor.update(() => {}, {tag: 'after-read'});
});`,
          errors: [{messageId: 'readOnlyUpdate'}],
        },
        {
          code: `editor.read(() => {
  editor.update(() => {}, updateOptions);
});`,
          errors: [{messageId: 'readOnlyUpdate'}],
        },
        {
          code: `editor.read(function $inspect() {
  editor.update(() => {});
});`,
          errors: [{messageId: 'readOnlyUpdate'}],
        },
        {
          code: `props.editor.update(() => {
  props.editor.update(() => {});
});`,
          errors: [{messageId: 'noNestedEditorUpdates'}],
        },
        {
          code: `$getEditor().read(() => {
  $getEditor().update(() => {});
});`,
          errors: [{messageId: 'readOnlyUpdate'}],
        },
        {
          code: `childEditor.update(function $inner() {
  childEditor.update(() => {});
});`,
          errors: [{messageId: 'noNestedEditorUpdates'}],
        },
        {
          code: `class Example {
  run() {
    this.editor.update(() => {
      this.editor.update(() => {});
    });
  }
}`,
          errors: [{messageId: 'noNestedEditorUpdates'}],
        },
      ],
      valid: [
        `editor.update(() => {
  nestedEditor.update(() => {});
});`,
        `editor.registerCommand(COMMAND, () => {
  const nestedEditor = getNestedEditor();
  nestedEditor.update(() => {});
  return true;
}, PRIORITY);`,
        `editor.registerNodeTransform(Node, node => {
  childEditor.update(() => node.remove());
});`,
        `editor.update(() => {
  child.getOrResetEditor().update(() => {});
});`,
        `editor.read(() => {
  childEditor.update(() => {});
});`,
        `const editor = getEditor();
editor.update(() => {
  const editor = getNestedEditor();
  editor.update(() => {});
});`,
        `session.update(() => {
  editor.update(() => {});
});`,
        `session.registerCommand(COMMAND, () => {
  editor.update(() => {});
}, PRIORITY);`,
        `editor.registerCommand(COMMAND, () => {
  session.update(() => {});
}, PRIORITY);`,
        `editor.registerUpdateListener(() => {
  editor.update(() => {});
});`,
        `editor.update(() => {
  setTimeout(() => editor.update(() => {}), 0);
});`,
        `editor.update(() => {
  editor.update(() => {}, {skipTransforms: true});
  editor.update(() => {}, {tag: 'history-merge', skipTransforms: true});
});`,
        `editor.update(() => {
  editor.update(() => {}, updateOptions);
  editor.update(() => {}, {...updateOptions});
  editor.update(() => {}, {['tag']: 'history-merge'});
  editor.update(() => {}, {event: null});
});`,
        `class Example {
  run() {
    this.editor.update(function () {
      this.editor.update(() => {});
    });
  }
}`,
        `const $handler = useCallback(() => {
  childEditor.update(() => {});
}, [childEditor]);
childEditor.registerCommand(COMMAND, $handler, PRIORITY);`,
      ],
    });
  });

  it('supports additional editor identifier patterns', () => {
    ruleTester.run('isEditor option', rule, {
      invalid: [
        {
          code: `function $updateSomething(lexicalInstance) {
  lexicalInstance.update(() => {});
}`,
          errors: [{messageId: 'dollarFunctionUpdate'}],
          options: [{isEditor: '^lexicalInstance$'}],
        },
        {
          code: `const lexicalInstance = getEditor();
lexicalInstance.update(() => {
  lexicalInstance.update(() => {});
});`,
          errors: [{messageId: 'noNestedEditorUpdates'}],
          options: [{isEditor: '^lexicalInstance$'}],
        },
        {
          code: `getMyEditor().update(() => {
  getMyEditor().update(() => {});
});`,
          errors: [{messageId: 'noNestedEditorUpdates'}],
          options: [{isEditor: '^getMyEditor$'}],
        },
      ],
      valid: [
        `function $updateSomething(lexicalInstance) {
  lexicalInstance.update(() => {});
}`,
      ],
    });
  });

  it('is enabled by the default presets', () => {
    expect(
      plugin.configs['legacy-recommended'].rules[
        '@lexical/no-nested-editor-updates'
      ],
    ).toBe('warn');
    expect(
      plugin.configs['flat/recommended'].rules[
        '@lexical/no-nested-editor-updates'
      ],
    ).toBe('warn');
  });
});
