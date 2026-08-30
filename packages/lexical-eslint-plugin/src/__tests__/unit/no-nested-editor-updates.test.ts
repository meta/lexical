/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {RuleTester} from 'eslint';
import {describe, it} from 'vitest';

import plugin from '../../LexicalEslintPlugin.js';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2018,
    sourceType: 'module',
  },
});

const rule = plugin.rules['no-nested-editor-updates'];

describe('no-nested-editor-updates', () => {
  it('reports editor.update calls from $functions', () => {
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
              messageId: 'noNestedEditorUpdates',
            },
          ],
        },
        {
          code: `const $updateSomething = () => {
  nestedEditor.update(() => {});
};`,
          errors: [{messageId: 'noNestedEditorUpdates'}],
        },
        {
          code: `const $updateSomething = useCallback(() => {
  editor.update(() => {});
}, [editor]);`,
          errors: [{messageId: 'noNestedEditorUpdates'}],
        },
        {
          code: `function $updateSomething() {
  $getEditor().update(() => {});
}`,
          errors: [{messageId: 'noNestedEditorUpdates'}],
        },
      ],
      valid: [
        `function updateSomething(editor) {
  editor.update(() => {});
}`,
        `function $updateSomething(session) {
  session.update(() => {});
}`,
        `function $updateSomething(editor) {
  setTimeout(() => editor.update(() => {}), 0);
}`,
      ],
    });
  });

  it('reports nested updates from implicit update callbacks', () => {
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
          code: `editor.registerCommand(COMMAND, () => {
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
          code: `editor.registerNodeTransform(Node, node => {
  nestedEditor.update(() => node.remove());
});`,
          errors: [{messageId: 'noNestedEditorUpdates'}],
        },
      ],
      valid: [
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
          errors: [{messageId: 'noNestedEditorUpdates'}],
          options: [{isEditor: '^lexicalInstance$'}],
        },
      ],
      valid: [
        `function $updateSomething(lexicalInstance) {
  lexicalInstance.update(() => {});
}`,
      ],
    });
  });
});
