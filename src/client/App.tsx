import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Boxes, GitBranch, RefreshCw, Zap} from 'lucide-react';
import {api, ApiError, StaleRevisionError} from './api';
import {CandidatesTable, ConflictPane, GraphPane, SkippedList} from './components';
import type {
  Candidate,
  ChangeReq,
  ConflictSubgraph,
  Level,
  PackageGraph,
  PlanResult,
  PlanSuccess,
  SkippedEdge,
} from '../shared/model';

type ChangeDraft =
  | {mode: 'level'; level: Level}
  | {mode: 'version'; to: string};

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;

export default function App() {
  const [graph, setGraph] = useState<PackageGraph | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ChangeDraft>>({});
  const [plan, setPlan] = useState<PlanSuccess | null>(null);
  const [conflict, setConflict] = useState<ConflictSubgraph | null>(null);
  const [busy, setBusy] = useState<'idle' | 'compute' | 'recompute' | 'mutate'>('idle');
  const [notice, setNotice] = useState<string>('加载固定 revision 依赖图…');
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [incremental, setIncremental] = useState(false);
  // 本地未提交的候选版本调整
  const [overrideDrafts, setOverrideDrafts] = useState<Record<string, string>>({});

  // 单调请求序号：旧计算结果不得覆盖新调整
  const seqRef = useRef(0);
  // 用于并发修改演示的待提交变更
  const [mutateVersion, setMutateVersion] = useState('');

  useEffect(() => {
    api
      .graph()
      .then((g) => {
        setGraph(g);
        setSelectedNode(g.nodes[0]?.id ?? null);
        setNotice(`图 revision ${g.revision} 已加载（本地模拟，不连接包仓库）`);
      })
      .catch(() => setNotice('加载失败'));
  }, []);

  const selectedChanges: ChangeReq[] = useMemo(() => {
    if (!graph) return [];
    return Object.entries(drafts).map(([id, d]) => {
      const node = graph.nodes.find((n) => n.id === id)!;
      if (d.mode === 'version') return {id, to: d.to};
      return {id, level: d.level};
    });
  }, [drafts, graph]);

  const applyResult = useCallback(
    (result: PlanResult, mode: 'full' | 'incremental') => {
      if (result.ok) {
        setConflict(null);
        // 把服务端结果合并到本地草稿（保留尚未重算的输入）
        setPlan(result);
        setOverrideDrafts((prev) => {
          const next: Record<string, string> = {};
          for (const c of result.candidates) next[c.id] = c.to;
          // 保留不在本轮候选里的旧调整无意义；但保留未提交输入草稿
          for (const [k, v] of Object.entries(prev)) {
            if (!(k in next) && drafts[k]) next[k] = v;
          }
          return next;
        });
        setRemovedIds(result.removedIds ?? []);
        setIncremental(mode === 'incremental');
        setNotice(
          mode === 'incremental'
            ? `增量重算完成（revision ${result.graphRevision}）：受影响 ${result.affectedNodes?.length ?? 0} 个包，沿用上轮 ${result.candidates.filter((c) => c.recomputed === false).length} 个`
            : `版本计划已生成（revision ${result.graphRevision}）：${result.candidates.length} 个候选`,
        );
      } else {
        setConflict(result.conflict);
        setNotice(`无法满足：${result.conflict.kind} —— 已返回最小冲突子图`);
      }
    },
    [drafts],
  );

  const runCompute = useCallback(async () => {
    if (!graph) return;
    const seq = ++seqRef.current;
    setBusy('compute');
    setNotice('全量计算受影响子图…');
    try {
      const result = await api.compute(graph.revision, selectedChanges, {});
      if (seq !== seqRef.current) return; // 旧结果丢弃，不能覆盖新调整
      applyResult(result, 'full');
    } catch (err) {
      await handleErr(err, seq);
    } finally {
      if (seq === seqRef.current) setBusy('idle');
    }
  }, [graph, selectedChanges, applyResult]);

  const runRecompute = useCallback(
    async (adjustedId: string) => {
      if (!graph || !plan) return;
      const newValue = overrideDrafts[adjustedId];
      if (newValue === undefined || !SEMVER_RE.test(newValue)) {
        setNotice(`候选版本非法：${newValue ?? ''}（需 x.y.z[-prerelease]）`);
        return;
      }
      const seq = ++seqRef.current;
      setBusy('recompute');
      setNotice(`仅重算 ${adjustedId} 的反向可达子图…`);
      try {
        const result = await api.recompute(graph.revision, {
          changes: selectedChanges,
          overrides: {[adjustedId]: newValue},
          adjustedId,
          previous: plan.candidates.map((c: Candidate) => ({id: c.id, to: c.to, rangeUpdates: c.rangeUpdates})),
        });
        if (seq !== seqRef.current) return;
        applyResult(result, 'incremental');
      } catch (err) {
        await handleErr(err, seq);
      } finally {
        if (seq === seqRef.current) setBusy('idle');
      }
    },
    [graph, plan, overrideDrafts, selectedChanges, applyResult],
  );

  const handleErr = useCallback(async (err: unknown, seq: number) => {
    if (seq !== seqRef.current) return;
    if (err instanceof StaleRevisionError) {
      setGraph(err.current);
      setPlan(null);
      setConflict(null);
      setNotice(`图已被并发修改，服务端 revision ${err.current.revision} 已载入；旧计划作废，请重新计算`);
      return;
    }
    if (err instanceof ApiError) {
      const body = err.body as {message?: string};
      setNotice(`请求失败 ${err.status}：${body?.message ?? '未知错误'}`);
    }
  }, []);

  // 并发修改图演示：按 revision 乐观锁提交；先制造冲突（旧 revision）再成功提交
  const demoConcurrentMutate = useCallback(
    async (stale: boolean) => {
      if (!graph || !selectedNode) return;
      const seq = ++seqRef.current;
      setBusy('mutate');
      const rev = stale ? Math.max(0, graph.revision - 1) : graph.revision;
      setNotice(stale ? '用旧 revision 提交（应被拒绝）…' : `按 revision ${rev} 修改图…`);
      try {
        const next = await api.mutate(rev, {
          op: 'set-version',
          id: selectedNode,
          version: mutateVersion || graph.nodes.find((n) => n.id === selectedNode)?.version,
        });
        if (seq !== seqRef.current) return;
        setGraph(next);
        setPlan(null);
        setConflict(null);
        setNotice(stale ? '意外成功？' : `图已更新到 revision ${next.revision}，请重新选择变更并计算`);
      } catch (err) {
        await handleErr(err, seq);
        if (!stale) setNotice('修改失败');
      } finally {
        if (seq === seqRef.current) setBusy('idle');
      }
    },
    [graph, selectedNode, mutateVersion, handleErr],
  );

  if (!graph) return <main className="shell">加载中…</main>;

  const toggleDraft = (id: string) => {
    setDrafts((prev) => {
      const next = {...prev};
      if (next[id]) delete next[id];
      else next[id] = {mode: 'level', level: 'patch'};
      return next;
    });
  };

  const setDraftLevel = (id: string, level: Level) =>
    setDrafts((prev) => ({...prev, [id]: {mode: 'level', level}}));
  const setDraftVersion = (id: string, to: string) =>
    setDrafts((prev) => ({...prev, [id]: {mode: 'version', to}}));

  const skipped: SkippedEdge[] = plan?.skipped ?? [];
  const candidates: Candidate[] = plan?.candidates ?? [];


  return (
    <main className="shell">
      <header className="topbar">
        <Boxes size={20} />
        <strong>发布依赖工作台</strong>
        <span className="revision-pill">
          <GitBranch size={13} /> graph revision {graph.revision}
        </span>
        <span className="mode-pill">{busy === 'idle' ? '本地模拟' : busy}</span>
        <span className="notice">{notice}</span>
      </header>

      <section className="workspace">
        <aside className="pane pane-left">
          <h2>1. 依赖图（固定 revision）</h2>
          <GraphPane graph={graph} selectedId={selectedNode} onSelect={setSelectedNode} />
          <div className="mutate-box">
            <h4>并发修改图（乐观锁演示）</h4>
            <label>
              修改 <code>{selectedNode}</code> 版本：
              <input
                value={mutateVersion}
                placeholder={graph.nodes.find((n) => n.id === selectedNode)?.version}
                onChange={(e) => setMutateVersion(e.target.value)}
              />
            </label>
            <div className="btn-row">
              <button onClick={() => demoConcurrentMutate(true)} title="用过期 revision 提交，应返回 409">
                旧 revision 提交
              </button>
              <button className="primary" onClick={() => demoConcurrentMutate(false)}>
                提交修改
              </button>
            </div>
          </div>
        </aside>

        <section className="pane pane-center">
          <h2>2. 选择包变更</h2>
          <div className="changes">
            {graph.nodes.map((n) => {
              const d = drafts[n.id];
              return (
                <div key={n.id} className={`change-row ${d ? 'on' : ''}`}>
                  <label className="pick">
                    <input type="checkbox" checked={!!d} onChange={() => toggleDraft(n.id)} />
                    <button className="link" onClick={() => setSelectedNode(n.id)}>
                      {n.name}
                    </button>
                    <code>{n.version}</code>
                    {n.external ? <em className="tag tag-ext">外部</em> : null}
                    {n.private ? <em className="tag tag-private">私有</em> : null}
                  </label>
                  {d && (
                    <span className="change-edit">
                      <select
                        value={d.mode === 'level' ? d.level : 'custom'}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === 'custom') setDraftVersion(n.id, n.version);
                          else setDraftLevel(n.id, v as Level);
                        }}
                      >
                        <option value="patch">patch</option>
                        <option value="minor">minor</option>
                        <option value="major">major</option>
                        <option value="custom">指定版本…</option>
                      </select>
                      {d.mode === 'version' && (
                        <input
                          className="version-input"
                          value={d.to}
                          onChange={(e) => setDraftVersion(n.id, e.target.value)}
                          placeholder="2.0.0"
                        />
                      )}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <div className="compute-bar">
            <button className="primary big" onClick={runCompute} disabled={busy !== 'idle' || selectedChanges.length === 0}>
              <Zap size={15} /> 计算候选版本计划
            </button>
            <span className="muted small">沿运行/可选/peer 边传播 major·minor·patch 的最小影响；多路径取满足全部约束的结果</span>
          </div>

          <h2>3. 候选版本计划 {incremental && <em className="tag tag-carried">增量</em>}</h2>
          {plan && (
            <CandidatesTable
              candidates={candidates}
              draftOverrides={overrideDrafts}
              onOverride={(id, value) => setOverrideDrafts((p) => ({...p, [id]: value}))}
              onRecompute={runRecompute}
              selectedIds={new Set(selectedChanges.map((c) => c.id))}
              removedIds={removedIds}
              onSelectNode={setSelectedNode}
            />
          )}
          {conflict ? (
            <ConflictPane
              conflict={conflict}
              onSelectNode={(id) => setSelectedNode(id)}
              selectedEdge={selectedEdge}
              onSelectEdge={(key) => {
                setSelectedEdge(key);
                const [from] = key.split('->');
                setSelectedNode(from);
                setNotice(`已在左栏定位原因边 ${key} 所属包 ${from}`);
              }}
            />
          ) : (
            !plan && <p className="muted">选择变更后点击“计算候选版本计划”。不会连接包仓库，也不会真正发版。</p>
          )}
          {plan && <SkippedList skipped={skipped} />}
          {plan && plan.mode === 'incremental' && (
            <p className="muted small">
              <RefreshCw size={12} /> 受影响子图：{(plan.affectedNodes ?? []).join(', ') || '（空）'}
            </p>
          )}
        </section>
      </section>
    </main>
  );
}
