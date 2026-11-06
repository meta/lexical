/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import './styles.css';

import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App.tsx';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="App">
      <h1>Lexical in a Shadow DOM</h1>
      <p className="App-blurb">
        The editor below is rendered inside an open <code>ShadowRoot</code>. The
        toolbar lives in the light DOM <em>outside</em> the shadow boundary.
        Selection is resolved with <code>Selection.getComposedRanges</code> and
        focus with <code>ShadowRoot.activeElement</code>, so typing, selection,
        keyboard navigation, formatting and deletion all work across the shadow
        boundary using platform APIs only.
      </p>
      <App />
    </div>
  </React.StrictMode>,
);
