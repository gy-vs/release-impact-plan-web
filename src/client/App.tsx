import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {RefreshCw, GitBranch, ShieldAlert, Pencil} from 'lucide-react';
import type {Conflict, Graph, Plan, RefineResult, Seed} from '../shared/types';
import {api} from './api';
import {DependencyGraph} from './DependencyGraph';
import {CandidatePanel} from './CandidatePanel';
import {SeedPanel} from './SeedPanel';
import {GraphEditor} from './GraphEditor';

type Status = {kind: 'idle' | 'working' | 'conflict'; text: string; detail?: string};

export default function App() {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [seeds, setSeeds] = useState<Seed[]>([{pkg: 'core', level: 'major'}]);
  const [overrides, setOverrides] = useState<Seed[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [affected, setAffected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<Status>({kind: 'idle', text: 'Ready'});
  const [selectedPkg, setSelectedPkg] = useState<string | null>(null);
  const [focusConflict, setFocusConflict] = useState<Conflict | null>(null);
  const [highlightEdge, setHighlightEdge] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  // Monotonic request token + abort controller: a stale response can never
  // overwrite a newer adjustment, and in-flight requests are cancelled when a
  // new edit supersedes them.
  const requestSeq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const session = useRef(`s-${Math.random().toString(36).slice(2)}`).current;
  // latest selection kept in refs so async callbacks always see the new value
  const seedsRef = useRef(seeds);
  const overridesRef = useRef(overrides);
  seedsRef.current = seeds;
  overridesRef.current = overrides;

  useEffect(() => {
    api.graph().then(setGraph);
  }, []);

  const runRequest = useCallback(
    async (
      mode: 'plan' | 'refine',
      revision: number,
      nextSeeds: Seed[],
      nextOverrides: Seed[],
      workingText: string,
    ) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const seq = ++requestSeq.current;
      setStatus({kind: 'working', text: workingText});
      try {
        // new adjustment landed (or unmount/abort): this result is obsolete
        const body =
          mode === 'plan'
            ? await api.plan(revision, nextSeeds, nextOverrides, session)
            : await api.refine(revision, nextSeeds, nextOverrides, session);
        if (seq !== requestSeq.current || controller.signal.aborted) return;
        setPlan(body.plan);
        const affectedIds =
          mode === 'refine'
            ? new Set<string>((body as RefineResult).affected)
            : new Set<string>(body.plan.candidates.map((c) => c.pkg));
        setAffected(affectedIds);
        setStatus(
          body.plan.conflicts.length
            ? {
                kind: 'conflict',
                text: `${body.plan.candidates.length} candidates · ${body.plan.conflicts.length} conflict(s)`,
                detail: body.plan.conflicts[0].message,
              }
            : {
                kind: 'idle',
                text:
                  mode === 'refine'
                    ? `${(body as RefineResult).affected.length} affected · ${
                        (body as RefineResult).reused.length
                      } reused · rev ${body.plan.revision}`
                    : `${body.plan.candidates.length} candidates · rev ${body.plan.revision}`,
              },
        );
      } catch (err: unknown) {
        if (seq !== requestSeq.current) return; // superseded
        const e = err as {status?: number; current?: Graph; message?: string};
        if (e.status === 409 && e.current) {
          setGraph(e.current);
          setStatus({
            kind: 'conflict',
            text: 'Graph changed concurrently — refreshed',
            detail: `A concurrent edit moved the graph to revision ${e.current.revision}. Re-run to apply your selection.`,
          });
        } else {
          setStatus({kind: 'conflict', text: 'Request failed', detail: e.message});
        }
      }
    },
    [session],
  );

  // initial plan once the graph arrives
  const didInit = useRef(false);
  useEffect(() => {
    if (graph && !didInit.current) {
      didInit.current = true;
      runRequest('plan', graph.revision, seedsRef.current, overridesRef.current, 'Computing plan…');
    }
  }, [graph, runRequest]);

  const changeSeeds = useCallback(
    (next: Seed[]) => {
      setSeeds(next);
      if (!graph) return;
      runRequest('plan', graph.revision, next, overridesRef.current, 'Recomputing plan…');
    },
    [graph, runRequest],
  );

  const adjustCandidate = useCallback(
    (pkg: string, version: string) => {
      if (!graph) return;
      const next = version
        ? [...overridesRef.current.filter((o) => o.pkg !== pkg), {pkg, version}]
        : overridesRef.current.filter((o) => o.pkg !== pkg);
      setOverrides(next);
      runRequest(
        'refine',
        graph.revision,
        seedsRef.current,
        next,
        'Refining affected subgraph…',
      );
    },
    [graph, runRequest],
  );

  const fullRecompute = useCallback(() => {
    if (!graph) return;
    runRequest(
      'plan',
      graph.revision,
      seedsRef.current,
      overridesRef.current,
      'Full recompute…',
    );
  }, [graph, runRequest]);

  const handleGraphChanged = useCallback(
    (next: Graph) => {
      setGraph(next);
      // selection is computed against the new revision; old plan results must
      // not overwrite it, which the seq guard already guarantees.
      runRequest(
        'plan',
        next.revision,
        seedsRef.current,
        overridesRef.current,
        'Recomputing against new graph…',
      );
    },
    [runRequest],
  );

  const nodeById = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])), [graph]);

  const focusNode = useCallback((id: string) => {
    setSelectedPkg(id);
    setFocusConflict(null);
  }, []);

  const jumpToReasonEdge = useCallback((from: string, to: string, kind: string) => {
    setHighlightEdge(`${kind}:${from}->${to}`);
    setSelectedPkg(to);
    setFocusConflict(null);
  }, []);

  const jumpConflict = useCallback((c: Conflict) => {
    setFocusConflict(c);
    if (c.subgraph.nodes[0]) setSelectedPkg(c.subgraph.nodes[0]);
  }, []);

  return (
    <main className="shell">
      <header className="topbar">
        <GitBranch size={20} />
        <strong>Release Dependency Studio</strong>
        <small>local simulation · no registry · no publish</small>
        <span className="rev-badge">
          <ShieldAlert size={13} /> graph revision {graph?.revision ?? '—'}
        </span>
        <button className="ghost" onClick={fullRecompute} disabled={!graph}>
          <RefreshCw size={14} /> Full recompute
        </button>
        <button className="ghost" onClick={() => setEditorOpen(true)} disabled={!graph}>
          <Pencil size={14} /> Edit graph
        </button>
      </header>

      <section className="workspace">
        <SeedPanel graph={graph} seeds={seeds} onChange={changeSeeds} plan={plan} onFocusNode={focusNode} />

        <section className="pane graph-pane">
          <div className="pane-head">
            <h2>Dependency graph</h2>
            <Legend />
          </div>
          {graph && plan && (
            <DependencyGraph
              graph={graph}
              plan={plan}
              affected={affected}
              selectedPkg={selectedPkg}
              focusConflict={focusConflict}
              highlightEdge={highlightEdge}
              onSelectNode={focusNode}
            />
          )}
        </section>

        <CandidatePanel
          graph={graph}
          plan={plan}
          affected={affected}
          selectedPkg={selectedPkg}
          focusConflict={focusConflict}
          overrides={overrides}
          nodeById={nodeById}
          status={status}
          onAdjust={adjustCandidate}
          onSelectPkg={setSelectedPkg}
          onJumpEdge={jumpToReasonEdge}
          onJumpConflict={jumpConflict}
          onClearFocus={() => setFocusConflict(null)}
        />
      </section>

      {editorOpen && graph && (
        <GraphEditor
          graph={graph}
          onChanged={(g) => {
            handleGraphChanged(g);
            setEditorOpen(false);
          }}
          onClose={() => setEditorOpen(false)}
        />
      )}
    </main>
  );
}

function Legend() {
  return (
    <div className="legend">
      <span><i className="swatch runtime" />runtime</span>
      <span><i className="swatch optional" />optional</span>
      <span><i className="swatch peer" />peer</span>
      <span><i className="swatch seed" />selected change</span>
      <span><i className="swatch affected" />affected</span>
      <span><i className="swatch conflict" />conflict</span>
    </div>
  );
}
