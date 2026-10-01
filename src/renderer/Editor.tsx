import { useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { Settings } from '../shared/types';

export function Editor({ settings, onLength }: { settings: Settings; onLength: (length: number) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const appearance = useRef(new Compartment());
  const preferences = useRef(settings); preferences.current = settings;
  function theme(s: Settings) {
    return EditorView.theme({
      '&': { height: '100%', color: 'var(--text)', backgroundColor: 'var(--paper)', fontSize: `${s.fontSize}px` },
      '.cm-content': { fontFamily: `"${s.fontFamily}", ${['Consolas', 'Cascadia Code'].includes(s.fontFamily) ? 'monospace' : 'sans-serif'}`, padding: '28px 0', lineHeight: '1.85', minHeight: '100%', caretColor: 'var(--accent)' },
      '.cm-line': { padding: '0 28px' }, '.cm-scroller': { overflow: 'auto' },
      '.cm-gutters': { color: 'var(--muted)', backgroundColor: 'var(--paper)', borderRight: 'none', padding: '28px 8px 0 12px', fontSize: '12px' },
      '.cm-activeLine': { backgroundColor: 'var(--line)' }, '.cm-activeLineGutter': { backgroundColor: 'transparent' },
      '&.cm-focused': { outline: 'none' }, '.cm-cursor': { borderLeftColor: 'var(--accent)' },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--selection)' },
    }, { dark: s.theme === 'dark' });
  }
  useEffect(() => {
    let disposed = false, generation = 0;
    let doc: Y.Doc | undefined, awareness: Awareness | undefined;
    const pending: number[][] = [];
    let loading = true;
    const unsubscribeUpdate = window.desktop.onUpdate(data => {
      if (loading) pending.push(data); else if (doc) Y.applyUpdate(doc, new Uint8Array(data), 'backend');
    });
    async function load() {
      const current = ++generation; loading = true; pending.length = 0;
      const data = await window.desktop.document();
      if (disposed || current !== generation) return;
      view.current?.destroy(); awareness?.destroy(); doc?.destroy();
      doc = new Y.Doc(); Y.applyUpdate(doc, new Uint8Array(data), 'backend');
      for (const update of pending) Y.applyUpdate(doc, new Uint8Array(update), 'backend');
      pending.length = 0; loading = false;
      const text = doc.getText('note'); awareness = new Awareness(doc);
      doc.on('update', (update: Uint8Array, origin: unknown) => {
        if (origin !== 'backend') window.desktop.update([...update]);
        onLength(text.length);
      });
      const undoManager = new Y.UndoManager(text);
      view.current = new EditorView({
        parent: container.current!,
        state: EditorState.create({
          doc: text.toString(), extensions: [lineNumbers(), drawSelection(), highlightActiveLine(), EditorView.lineWrapping,
            keymap.of([...yUndoManagerKeymap, ...defaultKeymap]), yCollab(text, awareness, { undoManager }), appearance.current.of(theme(preferences.current)),
            EditorView.contentAttributes.of({ 'aria-label': '공동 메모 편집기', 'data-testid': 'note-editor' }),
          ],
        }),
      });
      onLength(text.length);
    }
    const unsubscribeReset = window.desktop.onReset(() => { void load(); });
    void load();
    return () => { disposed = true; unsubscribeUpdate(); unsubscribeReset(); view.current?.destroy(); awareness?.destroy(); doc?.destroy(); };
  }, []);
  useEffect(() => { view.current?.dispatch({ effects: appearance.current.reconfigure(theme(settings)) }); }, [settings.theme, settings.fontFamily, settings.fontSize]);
  return <div className="editor-mount" ref={container} />;
}
