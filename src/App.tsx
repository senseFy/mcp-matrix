import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react';
import ampIcon from '@lobehub/icons-static-svg/icons/amp.svg?url';
import claudeCodeIcon from '@lobehub/icons-static-svg/icons/claudecode.svg?url';
import codexIcon from '@lobehub/icons-static-svg/icons/codex.svg?url';
import mcpIcon from '@lobehub/icons-static-svg/icons/mcp.svg?url';
import openCodeIcon from '@lobehub/icons-static-svg/icons/opencode.svg?url';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ExternalLink,
  FileCode2,
  GitCompare,
  GripVertical,
  Minus,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Undo2,
  X,
} from 'lucide-react';

import type {
  AgentId,
  AgentSnapshot,
  ApplyResult,
  ChangePlan,
  PublicMcpOccurrence,
  SnapshotResponse,
} from './types';

const AGENT_ORDER: AgentId[] = ['claude', 'codex', 'droid', 'amp', 'opencode'];

const DOCS: Record<AgentId, string> = {
  claude: 'https://code.claude.com/docs/en/mcp',
  codex: 'https://developers.openai.com/codex/mcp/',
  droid: 'https://docs.factory.ai/cli/configuration/mcp',
  amp: 'https://ampcode.com/manual#mcp-servers',
  opencode: 'https://opencode.ai/docs/mcp-servers/',
};

interface MatrixRow {
  id: string;
  displayName: string;
  occurrences: Map<AgentId, PublicMcpOccurrence>;
  representative: PublicMcpOccurrence;
  divergent: boolean;
  nameCollision: boolean;
}

interface Selection {
  rowId?: string;
  occurrenceId?: string;
  agentId?: AgentId;
}

interface Notice {
  message: string;
  undoToken?: string;
}

type LobeIconStyle = CSSProperties & { '--lobe-icon': string };

function LobeIcon({ url, size = 18 }: { url: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="lobe-icon"
      style={{ '--lobe-icon': `url("${url}")`, fontSize: size } as LobeIconStyle}
    />
  );
}

function MCP({ size = 18 }: { size?: number }) {
  return <LobeIcon size={size} url={mcpIcon} />;
}

function AgentIcon({ id, size = 18 }: { id: AgentId; size?: number }) {
  if (id === 'claude') return <LobeIcon size={size} url={claudeCodeIcon} />;
  if (id === 'codex') return <LobeIcon size={size} url={codexIcon} />;
  if (id === 'amp') return <LobeIcon size={size} url={ampIcon} />;
  if (id === 'opencode') return <LobeIcon size={size} url={openCodeIcon} />;
  return <MCP size={size} />;
}

async function api<T>(path: string, options?: RequestInit, mutationToken?: string): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body) headers.set('Content-Type', 'application/json');
  if (mutationToken) headers.set('X-MCP-Matrix-Token', mutationToken);
  const response = await fetch(path, {
    ...options,
    headers,
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

function buildRows(snapshot: SnapshotResponse | undefined): MatrixRow[] {
  if (!snapshot) return [];
  const groups = new Map<string, PublicMcpOccurrence[]>();
  for (const occurrence of snapshot.occurrences) {
    if (!occurrence.source.effective) continue;
    const values = groups.get(occurrence.identityFingerprint) ?? [];
    values.push(occurrence);
    groups.set(occurrence.identityFingerprint, values);
  }
  const namesByIdentity = new Map<string, Set<string>>();
  for (const [identity, values] of groups) {
    for (const value of values) {
      const normalized = value.name.toLocaleLowerCase();
      const identities = namesByIdentity.get(normalized) ?? new Set<string>();
      identities.add(identity);
      namesByIdentity.set(normalized, identities);
    }
  }

  return [...groups.entries()]
    .map(([identity, values]) => {
      const nameCounts = new Map<string, number>();
      for (const value of values) nameCounts.set(value.name, (nameCounts.get(value.name) ?? 0) + 1);
      const displayName = [...nameCounts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0][0];
      const representative = values.find((value) => value.enabled) ?? values[0];
      return {
        id: identity,
        displayName,
        occurrences: new Map(values.map((value) => [value.agentId, value])),
        representative,
        divergent: new Set(values.map((value) => value.configFingerprint)).size > 1,
        nameCollision: values.some(
          (value) => (namesByIdentity.get(value.name.toLocaleLowerCase())?.size ?? 0) > 1,
        ),
      };
    })
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function cellStatus(row: MatrixRow, occurrence: PublicMcpOccurrence | undefined): string {
  if (!occurrence) return 'Not configured';
  if (occurrence.transport.kind === 'unknown' || occurrence.warnings.some((warning) => /missing|invalid/i.test(warning))) {
    return 'Invalid';
  }
  if (!occurrence.enabled) return 'Disabled';
  if (row.divergent) return 'Different options';
  if (occurrence.source.scope !== 'user') return `Inherited · ${occurrence.source.scope}`;
  return 'Configured';
}

function statusClass(row: MatrixRow, occurrence: PublicMcpOccurrence | undefined): string {
  if (!occurrence) return 'empty';
  if (occurrence.transport.kind === 'unknown' || occurrence.warnings.some((warning) => /missing|invalid/i.test(warning))) {
    return 'invalid';
  }
  if (!occurrence.enabled) return 'disabled';
  if (row.divergent) return 'divergent';
  if (occurrence.source.scope !== 'user') return 'inherited';
  return 'configured';
}

function StatusMark({ status }: { status: string }) {
  if (status === 'empty') return <Plus size={13} />;
  if (status === 'invalid') return <AlertTriangle size={13} />;
  if (status === 'disabled') return <Minus size={13} />;
  if (status === 'divergent') return <GitCompare size={13} />;
  return <Check size={13} />;
}

function App() {
  const [snapshot, setSnapshot] = useState<SnapshotResponse>();
  const [workspace, setWorkspace] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [selection, setSelection] = useState<Selection>({});
  const [plan, setPlan] = useState<ChangePlan>();
  const [planning, setPlanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const [dragTarget, setDragTarget] = useState<string>();

  const scan = useCallback(async (requestedWorkspace?: string) => {
    setLoading(true);
    setError(undefined);
    try {
      const query = requestedWorkspace ? `?workspace=${encodeURIComponent(requestedWorkspace)}` : '';
      const next = await api<SnapshotResponse>(`/api/snapshot${query}`);
      setSnapshot(next);
      setWorkspace(next.workspace);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to scan MCP configurations.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void scan();
  }, [scan]);

  const rows = useMemo(() => buildRows(snapshot), [snapshot]);
  const visibleRows = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return rows;
    return rows.filter((row) =>
      [row.displayName, row.representative.transport.kind, ...[...row.occurrences.values()].map((value) => value.name)]
        .join(' ')
        .toLocaleLowerCase()
        .includes(query),
    );
  }, [rows, search]);

  const selectedRow = rows.find((row) => row.id === selection.rowId);
  const selectedOccurrence = snapshot?.occurrences.find(
    (occurrence) => occurrence.occurrenceId === selection.occurrenceId,
  );
  const selectedAgent = snapshot?.agents.find((agent) => agent.id === selection.agentId);

  const requestPlan = useCallback(
    async (occurrenceId: string, targetAgentId: AgentId) => {
      if (!snapshot) return;
      setPlanning(true);
      setError(undefined);
      try {
        const next = await api<ChangePlan>(
          '/api/plans',
          {
            method: 'POST',
            body: JSON.stringify({
              workspace: snapshot.workspace,
              occurrenceId,
              targetAgentId,
            }),
          },
          snapshot.mutationToken,
        );
        setPlan(next);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Unable to create a change preview.');
      } finally {
        setPlanning(false);
      }
    },
    [snapshot],
  );

  const selectCell = (row: MatrixRow, agentId: AgentId) => {
    const occurrence = row.occurrences.get(agentId);
    if (occurrence) {
      setSelection({ rowId: row.id, occurrenceId: occurrence.occurrenceId, agentId });
    } else {
      setSelection({ rowId: row.id, agentId });
      void requestPlan(row.representative.occurrenceId, agentId);
    }
  };

  const submitWorkspace = (event: FormEvent) => {
    event.preventDefault();
    if (workspace) void scan(workspace);
  };

  const applyCurrentPlan = async () => {
    if (!plan) return;
    setApplying(true);
    setError(undefined);
    try {
      const result = await api<ApplyResult>(
        `/api/plans/${encodeURIComponent(plan.planId)}/apply`,
        { method: 'POST' },
        snapshot?.mutationToken,
      );
      setPlan(undefined);
      setNotice({ message: `Added ${plan.targetName} to ${plan.targetAgentId}.`, undoToken: result.undoToken });
      await scan(snapshot?.workspace);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to apply this change.');
    } finally {
      setApplying(false);
    }
  };

  const undo = async (undoToken: string) => {
    setError(undefined);
    try {
      await api(
        '/api/undo',
        { method: 'POST', body: JSON.stringify({ undoToken }) },
        snapshot?.mutationToken,
      );
      setNotice({ message: 'The last configuration change was restored.' });
      await scan(snapshot?.workspace);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to undo this change.');
    }
  };

  const handleDrop = (row: MatrixRow, targetAgentId: AgentId, occurrenceId: string) => {
    setDragTarget(undefined);
    const draggedOccurrence = snapshot?.occurrences.find(
      (occurrence) => occurrence.occurrenceId === occurrenceId,
    );
    if (!draggedOccurrence || draggedOccurrence.identityFingerprint !== row.id) {
      setError('Drop onto an empty cell in the same MCP row.');
      return;
    }
    if (row.occurrences.has(targetAgentId)) {
      setError('That agent already has this MCP identity configured.');
      return;
    }
    void requestPlan(occurrenceId, targetAgentId);
  };

  return (
    <div className="app-shell">
      <aside className="activity-bar" aria-label="Primary navigation">
        <div className="brand-mark" title="MCP Matrix">
          <MCP size={21} />
        </div>
        <button className="activity-item active" type="button" aria-label="Matrix">
          <span className="matrix-glyph"><i /><i /><i /><i /></span>
        </button>
        <div className="activity-spacer" />
        <div className="local-badge" title="Local-only configuration manager">
          <ShieldCheck size={15} />
        </div>
      </aside>

      <div className="workspace-shell">
        <header className="titlebar">
          <div className="product-title">
            <strong>MCP Matrix</strong>
            <span>Configuration, not connection</span>
          </div>
          <form className="workspace-picker" onSubmit={submitWorkspace}>
            <span className="workspace-label">Workspace</span>
            <input
              value={workspace}
              onChange={(event) => setWorkspace(event.target.value)}
              aria-label="Workspace path"
              spellCheck={false}
            />
            <button type="submit" className="icon-button" title="Scan workspace" disabled={loading}>
              <RefreshCw size={14} className={loading ? 'spin' : ''} />
            </button>
          </form>
          <div className="local-state"><span /> Local only</div>
        </header>

        <div className="content-grid">
          <main className="matrix-panel">
            <div className="panel-toolbar">
              <div>
                <h1>MCP inventory</h1>
                <p>{rows.length} identities across {AGENT_ORDER.length} agents</p>
              </div>
              <label className="search-box">
                <Search size={13} />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Filter servers"
                  aria-label="Filter MCP servers"
                />
                {search && <button type="button" onClick={() => setSearch('')}><X size={12} /></button>}
              </label>
            </div>

            {error && (
              <div className="error-banner" role="alert">
                <AlertTriangle size={14} />
                <span>{error}</span>
                <button type="button" onClick={() => setError(undefined)}><X size={13} /></button>
              </div>
            )}

            <div className="matrix-scroll">
              <div className="matrix-table" role="grid" aria-label="MCP configuration matrix">
                <div className="matrix-header server-column" role="columnheader">
                  <span>MCP server</span>
                  <span className="muted">identity</span>
                </div>
                {AGENT_ORDER.map((agentId) => {
                  const agent = snapshot?.agents.find((value) => value.id === agentId);
                  return (
                    <button
                      className={`matrix-header agent-header ${selection.agentId === agentId && !selection.rowId ? 'selected' : ''}`}
                      key={agentId}
                      type="button"
                      role="columnheader"
                      onClick={() => setSelection({ agentId })}
                    >
                      <AgentIcon id={agentId} />
                      <span>{agent?.shortName ?? agentId}</span>
                      <small>{agent?.occurrenceCount ?? 0}</small>
                    </button>
                  );
                })}

                {loading && !snapshot ? (
                  <div className="loading-row"><RefreshCw size={16} className="spin" /> Reading native configurations…</div>
                ) : visibleRows.length === 0 ? (
                  <div className="empty-row">
                    <MCP size={24} />
                    <strong>{search ? 'No matching MCP servers' : 'No MCP servers found'}</strong>
                    <span>{search ? 'Try a different filter.' : 'Native config files remain the source of truth.'}</span>
                  </div>
                ) : (
                  visibleRows.map((row) => (
                    <div className="matrix-row" role="row" key={row.id}>
                      <button
                        className={`server-cell ${selection.rowId === row.id && !selection.occurrenceId ? 'selected' : ''}`}
                        type="button"
                        role="rowheader"
                        onClick={() => setSelection({ rowId: row.id })}
                      >
                        <span className="server-icon"><MCP size={15} /></span>
                        <span className="server-copy">
                          <strong>{row.displayName}</strong>
                          <small>{row.representative.transport.kind}</small>
                        </span>
                        {(row.divergent || row.nameCollision) && <GitCompare size={13} className="row-warning" />}
                      </button>
                      {AGENT_ORDER.map((agentId) => {
                        const occurrence = row.occurrences.get(agentId);
                        const status = statusClass(row, occurrence);
                        const dropId = `${row.id}:${agentId}`;
                        return (
                          <button
                            className={`matrix-cell ${status} ${occurrence && selection.occurrenceId === occurrence.occurrenceId ? 'selected' : ''} ${dragTarget === dropId ? 'drag-target' : ''}`}
                            key={agentId}
                            type="button"
                            role="gridcell"
                            draggable={Boolean(occurrence)}
                            title={occurrence ? `${cellStatus(row, occurrence)} — drag to copy` : `Copy ${row.displayName} to ${agentId}`}
                            onClick={() => selectCell(row, agentId)}
                            onDragStart={(event) => {
                              if (!occurrence) return;
                              event.dataTransfer.effectAllowed = 'copy';
                              event.dataTransfer.setData('application/x-mcp-occurrence', occurrence.occurrenceId);
                              event.dataTransfer.setData('text/plain', occurrence.occurrenceId);
                            }}
                            onDragOver={(event) => {
                              if (occurrence) return;
                              event.preventDefault();
                              event.dataTransfer.dropEffect = 'copy';
                              setDragTarget(dropId);
                            }}
                            onDragLeave={() => setDragTarget((current) => (current === dropId ? undefined : current))}
                            onDrop={(event) => {
                              event.preventDefault();
                              const occurrenceId =
                                event.dataTransfer.getData('application/x-mcp-occurrence') ||
                                event.dataTransfer.getData('text/plain');
                              if (occurrenceId) handleDrop(row, agentId, occurrenceId);
                            }}
                          >
                            <span className="status-mark"><StatusMark status={status} /></span>
                            <span className="cell-copy">
                              <strong>{cellStatus(row, occurrence)}</strong>
                              {occurrence && (occurrence.name !== row.displayName || occurrence.source.scope) && (
                                <small>
                                  {occurrence.name !== row.displayName
                                    ? occurrence.name
                                    : occurrence.source.scope}
                                </small>
                              )}
                            </span>
                            {occurrence && <GripVertical size={12} className="drag-handle" />}
                          </button>
                        );
                      })}
                    </div>
                  ))
                )}
              </div>
            </div>

            <footer className="legend-bar">
              <span><i className="dot configured" />Configured</span>
              <span><i className="dot inherited" />Inherited</span>
              <span><i className="dot divergent" />Different</span>
              <span><i className="dot disabled" />Disabled</span>
              <span><i className="dot invalid" />Invalid</span>
              <span className="legend-note">Values are read from native files. No MCP traffic passes through this app.</span>
            </footer>
          </main>

          <Inspector
            snapshot={snapshot}
            row={selectedRow}
            occurrence={selectedOccurrence}
            agent={selectedAgent}
            planning={planning}
            onCopy={requestPlan}
          />
        </div>
      </div>

      {plan && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => !applying && setPlan(undefined)}>
          <section className="diff-modal" role="dialog" aria-modal="true" aria-labelledby="diff-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <span className="eyebrow">Dry run</span>
                <h2 id="diff-title">Add {plan.targetName}</h2>
              </div>
              <button className="icon-button" type="button" onClick={() => setPlan(undefined)} disabled={applying}><X size={15} /></button>
            </header>
            <div className="plan-route">
              <span className="agent-token"><AgentIcon id={plan.targetAgentId} size={16} />{plan.targetAgentId}</span>
              <ArrowRight size={13} />
              <code>{plan.targetPath}</code>
            </div>
            {plan.warnings.length > 0 && (
              <div className="plan-warnings">
                <AlertTriangle size={14} />
                <div>{plan.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>
              </div>
            )}
            <div className="diff-heading">
              <span><FileCode2 size={13} /> Native config patch</span>
              <small>Sensitive values masked</small>
            </div>
            <pre className="diff-view">{plan.unifiedDiff.split('\n').map((line, index) => (
              <span className={line.startsWith('+') && !line.startsWith('+++') ? 'addition' : line.startsWith('@@') ? 'hunk' : ''} key={`${index}-${line}`}>
                {line}{'\n'}
              </span>
            ))}</pre>
            <footer>
              <div className="safety-copy"><ShieldCheck size={14} /><span>Backup, stale-file check, atomic write, then verify.</span></div>
              <button className="button secondary" type="button" onClick={() => setPlan(undefined)} disabled={applying}>Cancel</button>
              <button className="button primary" type="button" onClick={() => void applyCurrentPlan()} disabled={applying}>
                {applying ? <RefreshCw size={13} className="spin" /> : <Check size={13} />}
                Apply change
              </button>
            </footer>
          </section>
        </div>
      )}

      {notice && (
        <div className="toast" role="status">
          <Check size={14} />
          <span>{notice.message}</span>
          {notice.undoToken && (
            <button type="button" onClick={() => void undo(notice.undoToken!)}><Undo2 size={13} /> Undo</button>
          )}
          <button className="toast-close" type="button" onClick={() => setNotice(undefined)}><X size={12} /></button>
        </div>
      )}
    </div>
  );
}

function Inspector({
  snapshot,
  row,
  occurrence,
  agent,
  planning,
  onCopy,
}: {
  snapshot?: SnapshotResponse;
  row?: MatrixRow;
  occurrence?: PublicMcpOccurrence;
  agent?: AgentSnapshot;
  planning: boolean;
  onCopy: (occurrenceId: string, targetAgentId: AgentId) => Promise<void>;
}) {
  if (occurrence) {
    const shadowed = snapshot?.occurrences.filter(
      (value) => value.agentId === occurrence.agentId && value.name === occurrence.name && !value.source.effective,
    ).length ?? 0;
    const missingTargets = AGENT_ORDER.filter(
      (target) => target !== occurrence.agentId && !row?.occurrences.has(target),
    );
    return (
      <aside className="inspector-panel">
        <div className="inspector-header">
          <span className="inspector-icon"><MCP size={18} /></span>
          <div><h2>{occurrence.name}</h2><p>Native MCP entry</p></div>
        </div>
        <div className="inspector-section status-line">
          <span className={`status-pill ${occurrence.enabled ? 'ok' : 'off'}`}><i />{occurrence.enabled ? 'Configured' : 'Disabled'}</span>
          <span className="transport-pill">{occurrence.transport.kind}</span>
        </div>
        <InspectorField label="Agent">
          <span className="inline-agent"><AgentIcon id={occurrence.agentId} size={15} />{snapshot?.agents.find((value) => value.id === occurrence.agentId)?.name}</span>
        </InspectorField>
        <InspectorField label="Scope"><code>{occurrence.source.scope}</code>{shadowed > 0 && <small>{shadowed} shadowed layer{shadowed === 1 ? '' : 's'}</small>}</InspectorField>
        <InspectorField label="Source"><code className="path-value">{occurrence.source.path}</code></InspectorField>
        {occurrence.transport.commandPreview && <InspectorField label="Command"><code>{occurrence.transport.commandPreview}</code></InspectorField>}
        {occurrence.transport.endpointHost && <InspectorField label="Endpoint"><code>{occurrence.transport.endpointHost}</code></InspectorField>}
        {occurrence.transport.envKeys.length > 0 && <InspectorField label="Environment"><div className="tag-list">{occurrence.transport.envKeys.map((key) => <span key={key}>{key}=••••</span>)}</div></InspectorField>}
        {occurrence.transport.headerKeys.length > 0 && <InspectorField label="Headers"><div className="tag-list">{occurrence.transport.headerKeys.map((key) => <span key={key}>{key}: ••••</span>)}</div></InspectorField>}
        <InspectorField label="Fingerprint"><code>{occurrence.configFingerprint.slice(0, 16)}</code></InspectorField>
        {occurrence.warnings.length > 0 && <div className="inspector-warning"><AlertTriangle size={13} /><div>{occurrence.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div></div>}
        <div className="inspector-section copy-section">
          <h3>Copy configuration</h3>
          <p>Generate a native target config preview. Nothing is written until Apply.</p>
          <div className="copy-targets">
            {missingTargets.map((target) => (
              <button type="button" key={target} disabled={planning} onClick={() => void onCopy(occurrence.occurrenceId, target)}>
                <AgentIcon id={target} size={15} /><span>{target}</span><ArrowRight size={12} />
              </button>
            ))}
          </div>
          {missingTargets.length === 0 && <p className="copy-complete">Already present in every supported agent.</p>}
        </div>
      </aside>
    );
  }

  if (row) {
    return (
      <aside className="inspector-panel">
        <div className="inspector-header">
          <span className="inspector-icon"><MCP size={18} /></span>
          <div><h2>{row.displayName}</h2><p>MCP identity</p></div>
        </div>
        <div className="coverage-strip">
          {AGENT_ORDER.map((agentId) => <i className={row.occurrences.has(agentId) ? 'covered' : ''} key={agentId} />)}
        </div>
        <InspectorField label="Coverage"><strong>{row.occurrences.size} / {AGENT_ORDER.length} agents</strong></InspectorField>
        <InspectorField label="Transport"><code>{row.representative.transport.kind}</code></InspectorField>
        <InspectorField label="Identity"><code>{row.id.slice(0, 16)}</code></InspectorField>
        {(row.divergent || row.nameCollision) && (
          <div className="inspector-warning"><GitCompare size={13} /><p>{row.nameCollision ? 'The same name points to another MCP identity.' : 'Portable options differ between agents.'}</p></div>
        )}
        <div className="inspector-section copy-section">
          <h3>Add missing agents</h3>
          <p>Click a target to preview its native representation.</p>
          <div className="copy-targets">
            {AGENT_ORDER.filter((target) => !row.occurrences.has(target)).map((target) => (
              <button type="button" key={target} disabled={planning} onClick={() => void onCopy(row.representative.occurrenceId, target)}>
                <AgentIcon id={target} size={15} /><span>{target}</span><Plus size={12} />
              </button>
            ))}
          </div>
        </div>
      </aside>
    );
  }

  if (agent) {
    return (
      <aside className="inspector-panel">
        <div className="inspector-header agent-inspector">
          <span className="inspector-icon"><AgentIcon id={agent.id} size={20} /></span>
          <div><h2>{agent.name}</h2><p>{agent.occurrenceCount} effective MCP entries</p></div>
        </div>
        <div className="inspector-section status-line">
          <span className={`status-pill ${agent.detected ? 'ok' : 'off'}`}><i />{agent.detected ? 'Config detected' : 'No config found'}</span>
        </div>
        <InspectorField label="Native key"><code>{agent.configKey}</code></InspectorField>
        <InspectorField label="Transports"><div className="tag-list">{agent.transports.map((value) => <span key={value}>{value}</span>)}</div></InspectorField>
        <InspectorField label="Config paths">
          {agent.configPaths.length ? agent.configPaths.map((path) => <code className="path-value block" key={path}>{path}</code>) : <span className="muted">Not present</span>}
        </InspectorField>
        <a className="docs-link" href={DOCS[agent.id]} target="_blank" rel="noreferrer">Official MCP documentation <ExternalLink size={12} /></a>
      </aside>
    );
  }

  return (
    <aside className="inspector-panel inspector-empty">
      <div className="empty-inspector-icon"><GitCompare size={21} /></div>
      <h2>Inspect configuration</h2>
      <p>Select a server, agent, or matrix cell. Drag a configured cell onto an empty one to copy it.</p>
      <div className="boundary-card">
        <ShieldCheck size={15} />
        <div><strong>No proxy layer</strong><span>MCP Matrix never starts servers, handles OAuth, or intercepts agent traffic.</span></div>
      </div>
    </aside>
  );
}

function InspectorField({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="inspector-field"><span className="field-label">{label}</span><div>{children}</div></div>;
}

export default App;
