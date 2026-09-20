import {useState} from 'react';
import {Pencil, Plus, Trash2, X} from 'lucide-react';
import type {DepKind, Graph} from '../shared/types';
import {api} from './api';

/**
 * Minimal graph editor: add/remove an edge or bump a node version. Every
 * mutation is sent with the revision the UI is looking at; a 409 means a
 * concurrent edit won and the server's current graph is adopted instead of
 * silently overwriting it.
 */
export function GraphEditor({
  graph,
  onChanged,
  onClose,
}: {
  graph: Graph;
  onChanged: (g: Graph) => void;
  onClose: () => void;
}) {
  const [from, setFrom] = useState(graph.nodes[0]?.id ?? '');
  const [to, setTo] = useState(graph.nodes[1]?.id ?? '');
  const [kind, setKind] = useState<DepKind>('runtime');
  const [range, setRange] = useState('^1.0.0');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mutate = async (ops: unknown[]) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.mutate(graph.revision, ops);
      onChanged(res.graph);
    } catch (e: unknown) {
      const err = e as {status?: number; current?: Graph; message?: string};
      if (err.status === 409 && err.current) {
        onChanged(err.current);
        setError(`Revision conflict — adopted the newer revision ${err.current.revision}; retry your edit.`);
      } else {
        setError(err.message ?? 'mutation failed');
      }
    } finally {
      setBusy(false);
    }
  };

  const selectable = graph.nodes;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>
            <Pencil size={15} /> Edit graph (revision {graph.revision})
          </h3>
          <button className="ghost-sm" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        {error && <div className="modal-error">{error}</div>}

        <h4>Add dependency edge</h4>
        <div className="form-grid">
          <label>
            consumer
            <select value={from} onChange={(e) => setFrom(e.target.value)}>
              {selectable.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            dependency
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              {selectable.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            kind
            <select value={kind} onChange={(e) => setKind(e.target.value as DepKind)}>
              <option value="runtime">runtime</option>
              <option value="optional">optional</option>
              <option value="peer">peer</option>
            </select>
          </label>
          <label>
            range
            <input value={range} onChange={(e) => setRange(e.target.value)} />
          </label>
        </div>
        <button
          className="primary-sm"
          disabled={busy || from === to || !range.trim()}
          onClick={() => mutate([{op: 'addEdge', edge: {from, to, range: range.trim(), kind}}])}
        >
          <Plus size={13} /> Add edge
        </button>

        <h4>Existing edges</h4>
        <div className="edge-admin-list">
          {graph.edges.map((e) => (
            <div key={`${e.kind}:${e.from}->${e.to}`} className="edge-admin-row">
              <span className={`kind-tag ${e.kind}`}>{e.kind}</span>
              <span>
                {graph.nodes.find((n) => n.id === e.from)?.name ?? e.from} →{' '}
                {graph.nodes.find((n) => n.id === e.to)?.name ?? e.to} <code>{e.range}</code>
              </span>
              <button
                className="ghost-sm danger"
                disabled={busy}
                onClick={() => mutate([{op: 'removeEdge', from: e.from, to: e.to, kind: e.kind}])}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
