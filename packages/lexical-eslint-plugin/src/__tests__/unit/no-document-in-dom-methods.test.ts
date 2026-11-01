/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {RuleTester} from 'eslint';
import {describe, it} from 'vitest';

import plugin from '../../LexicalEslintPlugin.js';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2018,
    sourceType: 'module',
  },
});

describe('no-document-in-dom-methods', () => {
  const rule = plugin.rules['no-document-in-dom-methods'];

  it('reports and fixes document inside class method createDOM', () => {
    ruleTester.run('createDOM-class', rule, {
      invalid: [
        {
          code: `class MyNode extends ElementNode {
  createDOM() {
    return document.createElement('div');
  }
}`,
          errors: [{messageId: 'noDocumentInDomMethods'}],
          output: `class MyNode extends ElementNode {
  createDOM() {
    return $getDocument().createElement('div');
  }
}`,
        },
      ],
      valid: [],
    });
  });

  it('reports and fixes document inside updateDOM', () => {
    ruleTester.run('updateDOM-class', rule, {
      invalid: [
        {
          code: `class MyNode extends ElementNode {
  updateDOM(prev, dom) {
    const span = document.createElement('span');
    dom.appendChild(span);
  }
}`,
          errors: [{messageId: 'noDocumentInDomMethods'}],
          output: `class MyNode extends ElementNode {
  updateDOM(prev, dom) {
    const span = $getDocument().createElement('span');
    dom.appendChild(span);
  }
}`,
        },
      ],
      valid: [],
    });
  });

  it('reports multiple document references in exportDOM', () => {
    ruleTester.run('exportDOM-multiple', rule, {
      invalid: [
        {
          code: `class MyNode extends DecoratorNode {
  exportDOM() {
    const el = document.createElement('div');
    el.textContent = document.title;
    return { element: el };
  }
}`,
          errors: [
            {messageId: 'noDocumentInDomMethods'},
            {messageId: 'noDocumentInDomMethods'},
          ],
          output: `class MyNode extends DecoratorNode {
  exportDOM() {
    const el = $getDocument().createElement('div');
    el.textContent = $getDocument().title;
    return { element: el };
  }
}`,
        },
      ],
      valid: [],
    });
  });

  it('reports document inside $decorateDOM', () => {
    ruleTester.run('$decorateDOM', rule, {
      invalid: [
        {
          code: `class MyNode extends DecoratorNode {
  $decorateDOM() {
    return document.createTextNode('hello');
  }
}`,
          errors: [{messageId: 'noDocumentInDomMethods'}],
          output: `class MyNode extends DecoratorNode {
  $decorateDOM() {
    return $getDocument().createTextNode('hello');
  }
}`,
        },
      ],
      valid: [],
    });
  });

  it('reports document inside object-literal createDOM (Property node)', () => {
    ruleTester.run('createDOM-property', rule, {
      invalid: [
        {
          code: `const config = {
  createDOM() {
    return document.createElement('div');
  }
}`,
          errors: [{messageId: 'noDocumentInDomMethods'}],
          output: `const config = {
  createDOM() {
    return $getDocument().createElement('div');
  }
}`,
        },
      ],
      valid: [],
    });
  });

  it('reports document in nested function inside DOM method', () => {
    ruleTester.run('nested-function', rule, {
      invalid: [
        {
          code: `class MyNode extends ElementNode {
  createDOM() {
    function helper() {
      return document.createElement('span');
    }
    return helper();
  }
}`,
          errors: [{messageId: 'noDocumentInDomMethods'}],
          output: `class MyNode extends ElementNode {
  createDOM() {
    function helper() {
      return $getDocument().createElement('span');
    }
    return helper();
  }
}`,
        },
      ],
      valid: [],
    });
  });

  it('ignores document outside DOM methods', () => {
    ruleTester.run('outside-dom-method', rule, {
      invalid: [],
      valid: [
        {
          code: `function setup() {
  return document.createElement('div');
}`,
        },
      ],
    });
  });

  it('ignores $getDocument() already used', () => {
    ruleTester.run('already-fixed', rule, {
      invalid: [],
      valid: [
        {
          code: `class MyNode extends ElementNode {
  createDOM() {
    return $getDocument().createElement('div');
  }
}`,
        },
      ],
    });
  });

  it('ignores non-DOM methods on the same class', () => {
    ruleTester.run('non-dom-method', rule, {
      invalid: [],
      valid: [
        {
          code: `class MyNode extends ElementNode {
  serialize() {
    return document.title;
  }
}`,
        },
      ],
    });
  });
});
