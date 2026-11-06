/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import clsx from 'clsx';
import React, {useEffect, useState} from 'react';

import styles from './styles.module.css';

type PhaseId = 'start' | 'during' | 'after' | 'reconcile' | 'post';

const PHASES: readonly {id: PhaseId; title: string}[] = [
  {id: 'start', title: 'What starts an update'},
  {id: 'during', title: 'During the update'},
  {id: 'after', title: 'After the update'},
  {id: 'reconcile', title: 'When the batch is reconciled'},
  {id: 'post', title: 'After reconciliation'},
];

interface Snapshot {
  current: string;
  pending: string | null;
  dom: string;
}

interface Step {
  phase: PhaseId;
  label: string;
  detail: string;
  snapshot: Snapshot;
}

interface Scenario {
  id: string;
  label: string;
  steps: readonly Step[];
}

const HELLO = 'Paragraph\n└ Text "Hello"';
const HELLO_BANG = 'Paragraph\n└ Text "Hello!"';
const HELLO_DOM = '<p><span>Hello</span></p>';
const HELLO_BANG_DOM = '<p><span>Hello!</span></p>';

const PLAIN = 'Paragraph\n└ Text "Hello world"';
const BOLD = 'Paragraph\n├ Text "Hello "\n└ Text "world" (bold)';
const PLAIN_DOM = '<p><span>Hello world</span></p>';
const BOLD_DOM = '<p><span>Hello </span><strong>world</strong></p>';

const ONE = 'Root\n└ Paragraph "One"';
const TWO = 'Root\n├ Paragraph "One"\n└ Paragraph "Two"';
const THREE = 'Root\n├ Paragraph "One"\n├ Paragraph "Two"\n└ Paragraph "Three"';
const ONE_DOM = '<p>One</p>';
const THREE_DOM = '<p>One</p><p>Two</p><p>Three</p>';

const EXT_DOM = '<p><span>Hello</span><span class="ext">✨</span></p>';

const SCENARIOS: readonly Scenario[] = [
  {
    id: 'typing',
    label: 'Typing "!"',
    steps: [
      {
        detail:
          'In the common case of plain text typed into an existing text node, Lexical does not call preventDefault(), so the browser inserts the character into the DOM itself.',
        label: 'beforeinput event',
        phase: 'start',
        snapshot: {current: HELLO, dom: HELLO_BANG_DOM, pending: null},
      },
      {
        detail:
          'On the input event, Lexical starts an update to bring the editor state in line with what the browser typed.',
        label: 'input event starts an update',
        phase: 'start',
        snapshot: {current: HELLO, dom: HELLO_BANG_DOM, pending: null},
      },
      {
        detail:
          'This is the first update in the batch, so the frozen current state is cloned into a writable pending state.',
        label: 'Pending state cloned',
        phase: 'during',
        snapshot: {current: HELLO, dom: HELLO_BANG_DOM, pending: HELLO},
      },
      {
        detail:
          "The text node's content is set from the DOM. The current state is untouched.",
        label: 'Text read back from the DOM',
        phase: 'during',
        snapshot: {current: HELLO, dom: HELLO_BANG_DOM, pending: HELLO_BANG},
      },
      {
        detail:
          'Transforms registered for TextNode run because it changed, for example to turn "#tag" into a hashtag node. They repeat until nothing is dirty.',
        label: 'Node transforms run',
        phase: 'during',
        snapshot: {current: HELLO, dom: HELLO_BANG_DOM, pending: HELLO_BANG},
      },
      {
        detail:
          'The commit is scheduled for a microtask, so any other update in the same tick would join this batch.',
        label: 'Commit scheduled',
        phase: 'after',
        snapshot: {current: HELLO, dom: HELLO_BANG_DOM, pending: HELLO_BANG},
      },
      {
        detail: 'The pending state is frozen and becomes the current state.',
        label: 'Pending becomes current',
        phase: 'reconcile',
        snapshot: {current: HELLO_BANG, dom: HELLO_BANG_DOM, pending: null},
      },
      {
        detail:
          'The reconciler visits only the changed text node. The DOM already says "Hello!", so there is little to patch; then the DOM selection is updated.',
        label: 'DOM reconciled',
        phase: 'reconcile',
        snapshot: {current: HELLO_BANG, dom: HELLO_BANG_DOM, pending: null},
      },
      {
        detail:
          'Mutation, text content, and update listeners run with the new state, for example to autosave the document.',
        label: 'Listeners notified',
        phase: 'post',
        snapshot: {current: HELLO_BANG, dom: HELLO_BANG_DOM, pending: null},
      },
    ],
  },
  {
    id: 'command',
    label: 'Bold button (command)',
    steps: [
      {
        detail:
          'With "world" selected, the toolbar calls editor.dispatchCommand(FORMAT_TEXT_COMMAND, \'bold\').',
        label: 'dispatchCommand()',
        phase: 'start',
        snapshot: {current: PLAIN, dom: PLAIN_DOM, pending: null},
      },
      {
        detail:
          'Command handlers always run inside an update. They are called in priority order until one returns true.',
        label: 'Handlers run inside an update',
        phase: 'start',
        snapshot: {current: PLAIN, dom: PLAIN_DOM, pending: null},
      },
      {
        detail: 'The current state is cloned into a writable pending state.',
        label: 'Pending state cloned',
        phase: 'during',
        snapshot: {current: PLAIN, dom: PLAIN_DOM, pending: PLAIN},
      },
      {
        detail:
          'The rich text handler formats the selection: the text node is split, and the new "world" node gets the bold format. The DOM hasn\'t changed yet.',
        label: 'Handler changes the pending state',
        phase: 'during',
        snapshot: {current: PLAIN, dom: PLAIN_DOM, pending: BOLD},
      },
      {
        detail: 'Transforms run on both changed text nodes.',
        label: 'Node transforms run',
        phase: 'during',
        snapshot: {current: PLAIN, dom: PLAIN_DOM, pending: BOLD},
      },
      {
        detail: 'The commit is scheduled for a microtask.',
        label: 'Commit scheduled',
        phase: 'after',
        snapshot: {current: PLAIN, dom: PLAIN_DOM, pending: BOLD},
      },
      {
        detail: 'The pending state is frozen and becomes the current state.',
        label: 'Pending becomes current',
        phase: 'reconcile',
        snapshot: {current: BOLD, dom: PLAIN_DOM, pending: null},
      },
      {
        detail:
          'The reconciler updates the first span and creates a <strong> for the bold node, then restores the selection on "world".',
        label: 'DOM reconciled',
        phase: 'reconcile',
        snapshot: {current: BOLD, dom: BOLD_DOM, pending: null},
      },
      {
        detail:
          'Update listeners run. The toolbar reads the selection and shows the Bold button as active.',
        label: 'Listeners notified',
        phase: 'post',
        snapshot: {current: BOLD, dom: BOLD_DOM, pending: null},
      },
    ],
  },
  {
    id: 'update',
    label: 'Two editor.update() calls',
    steps: [
      {
        detail:
          'Your code calls editor.update() to append a paragraph "Two", and immediately calls it again to append "Three".',
        label: 'editor.update(fn)',
        phase: 'start',
        snapshot: {current: ONE, dom: ONE_DOM, pending: null},
      },
      {
        detail:
          'The first update clones the current state into a pending state.',
        label: 'Pending state cloned',
        phase: 'during',
        snapshot: {current: ONE, dom: ONE_DOM, pending: ONE},
      },
      {
        detail: 'The first callback appends "Two" to the pending state.',
        label: 'First callback runs',
        phase: 'during',
        snapshot: {current: ONE, dom: ONE_DOM, pending: TWO},
      },
      {
        detail: 'Transforms run on the new paragraph and its text.',
        label: 'Node transforms run',
        phase: 'during',
        snapshot: {current: ONE, dom: ONE_DOM, pending: TWO},
      },
      {
        detail:
          'The commit is scheduled for a microtask. Nothing has been committed or rendered yet.',
        label: 'Commit scheduled',
        phase: 'after',
        snapshot: {current: ONE, dom: ONE_DOM, pending: TWO},
      },
      {
        detail:
          'The second update runs before the microtask, so it reuses the same pending state instead of cloning again. Its callback appends "Three", and transforms run again.',
        label: 'Second update joins the batch',
        phase: 'after',
        snapshot: {current: ONE, dom: ONE_DOM, pending: THREE},
      },
      {
        detail:
          'The batch commits once: the pending state becomes the frozen current state.',
        label: 'Pending becomes current',
        phase: 'reconcile',
        snapshot: {current: THREE, dom: ONE_DOM, pending: null},
      },
      {
        detail: 'One reconciliation creates both new paragraphs in the DOM.',
        label: 'DOM reconciled',
        phase: 'reconcile',
        snapshot: {current: THREE, dom: THREE_DOM, pending: null},
      },
      {
        detail:
          'Update listeners are called once for the whole batch, not once per update.',
        label: 'Listeners notified',
        phase: 'post',
        snapshot: {current: THREE, dom: THREE_DOM, pending: null},
      },
    ],
  },
  {
    id: 'outside',
    label: 'Outside DOM change',
    steps: [
      {
        detail:
          "A browser extension inserts its own element into the editor's DOM. Lexical's MutationObserver reports it.",
        label: 'MutationObserver fires',
        phase: 'start',
        snapshot: {current: HELLO, dom: EXT_DOM, pending: null},
      },
      {
        detail:
          'Lexical starts an update, cloning the current state into a pending state.',
        label: 'Pending state cloned',
        phase: 'during',
        snapshot: {current: HELLO, dom: EXT_DOM, pending: HELLO},
      },
      {
        detail:
          'The element does not belong to any node, so Lexical removes it and the DOM matches the editor state again. (An outside text edit would instead be read into the pending state.)',
        label: 'Foreign element removed',
        phase: 'during',
        snapshot: {current: HELLO, dom: HELLO_DOM, pending: HELLO},
      },
      {
        detail:
          'The selection from before the change is restored, which is the only thing this update changed.',
        label: 'Selection restored',
        phase: 'during',
        snapshot: {current: HELLO, dom: HELLO_DOM, pending: HELLO},
      },
      {
        detail: 'The selection change schedules a commit.',
        label: 'Commit scheduled',
        phase: 'after',
        snapshot: {current: HELLO, dom: HELLO_DOM, pending: HELLO},
      },
      {
        detail:
          'The pending state becomes current. No nodes changed, so the reconciler only updates the DOM selection.',
        label: 'Selection reconciled',
        phase: 'reconcile',
        snapshot: {current: HELLO, dom: HELLO_DOM, pending: null},
      },
      {
        detail: 'Update listeners run, and the document content is unchanged.',
        label: 'Listeners notified',
        phase: 'post',
        snapshot: {current: HELLO, dom: HELLO_DOM, pending: null},
      },
    ],
  },
];

const PLAY_INTERVAL_MS = 2200;

function Pane({
  title,
  value,
  changed,
}: {
  title: string;
  value: string | null;
  changed: boolean;
}) {
  return (
    <div className={clsx(styles.pane, changed && styles.paneChanged)}>
      <div className={styles.paneTitle}>{title}</div>
      <pre className={styles.paneBody}>
        {value === null ? <span className={styles.none}>none</span> : value}
      </pre>
    </div>
  );
}

export default function UpdateLifecycle(): React.JSX.Element {
  const [scenarioIndex, setScenarioIndex] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const scenario = SCENARIOS[scenarioIndex];
  const steps = scenario.steps;
  const step = steps[stepIndex];
  const previous = stepIndex > 0 ? steps[stepIndex - 1].snapshot : null;
  const atEnd = stepIndex === steps.length - 1;
  // Playback stops by itself on the last step.
  const isPlaying = playing && !atEnd;

  useEffect(() => {
    if (!isPlaying) {
      return;
    }
    const id = setTimeout(() => setStepIndex(i => i + 1), PLAY_INTERVAL_MS);
    return () => clearTimeout(id);
  }, [isPlaying, stepIndex]);

  const selectScenario = (index: number) => {
    setScenarioIndex(index);
    setStepIndex(0);
    setPlaying(false);
  };

  const changed = (key: keyof Snapshot) =>
    previous !== null && previous[key] !== step.snapshot[key];

  return (
    <figure className={styles.root}>
      <figcaption className={styles.caption}>
        Step through an update. Pick what starts it:
      </figcaption>
      <div
        className={styles.scenarios}
        role="group"
        aria-label="What starts the update">
        {SCENARIOS.map((s, i) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={i === scenarioIndex}
            className={clsx(
              'button button--sm',
              i === scenarioIndex
                ? 'button--primary'
                : 'button--secondary button--outline',
            )}
            onClick={() => selectScenario(i)}>
            {s.label}
          </button>
        ))}
      </div>

      <ol className={styles.phases}>
        {PHASES.map(phase => {
          const phaseSteps = steps
            .map((s, i) => ({i, s}))
            .filter(({s}) => s.phase === phase.id);
          const active = step.phase === phase.id;
          return (
            <li
              key={phase.id}
              className={clsx(styles.phase, active && styles.phaseActive)}>
              <div className={styles.phaseTitle}>{phase.title}</div>
              <ol className={styles.steps}>
                {phaseSteps.map(({i, s}) => (
                  <li key={i}>
                    <button
                      type="button"
                      aria-current={i === stepIndex ? 'step' : undefined}
                      className={clsx(
                        styles.step,
                        i === stepIndex && styles.stepCurrent,
                        i < stepIndex && styles.stepDone,
                      )}
                      onClick={() => {
                        setPlaying(false);
                        setStepIndex(i);
                      }}>
                      {s.label}
                    </button>
                  </li>
                ))}
              </ol>
            </li>
          );
        })}
      </ol>

      <p className={styles.detail} aria-live="polite">
        <strong>{step.label}.</strong> {step.detail}
      </p>

      <div className={styles.panes}>
        <Pane
          title="Current state"
          value={step.snapshot.current}
          changed={changed('current')}
        />
        <Pane
          title="Pending state"
          value={step.snapshot.pending}
          changed={changed('pending')}
        />
        <Pane title="DOM" value={step.snapshot.dom} changed={changed('dom')} />
      </div>

      <div className={styles.controls}>
        <button
          type="button"
          className="button button--sm button--secondary"
          disabled={stepIndex === 0}
          onClick={() => {
            setPlaying(false);
            setStepIndex(i => Math.max(0, i - 1));
          }}>
          Back
        </button>
        <button
          type="button"
          className="button button--sm button--primary"
          onClick={() => {
            if (atEnd) {
              setStepIndex(0);
              setPlaying(true);
            } else {
              setPlaying(!isPlaying);
            }
          }}>
          {isPlaying ? 'Pause' : atEnd ? 'Replay' : 'Play'}
        </button>
        <button
          type="button"
          className="button button--sm button--secondary"
          disabled={atEnd}
          onClick={() => {
            setPlaying(false);
            setStepIndex(i => Math.min(steps.length - 1, i + 1));
          }}>
          Next
        </button>
        <span className={styles.counter}>
          Step {stepIndex + 1} of {steps.length}
        </span>
      </div>
    </figure>
  );
}
