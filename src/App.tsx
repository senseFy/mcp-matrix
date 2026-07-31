import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react';
import ampIcon from '@lobehub/icons-static-svg/icons/amp.svg?url';
import claudeCodeIcon from '@lobehub/icons-static-svg/icons/claudecode.svg?url';
import codexIcon from '@lobehub/icons-static-svg/icons/codex.svg?url';
import mcpIcon from '@lobehub/icons-static-svg/icons/mcp.svg?url';
import openCodeIcon from '@lobehub/icons-static-svg/icons/opencode.svg?url';
import piIcon from '@lobehub/icons-static-svg/icons/pi.svg?url';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ExternalLink,
  FileCode2,
  GitCompare,
  GripVertical,
  KeyRound,
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
  AuthUpdate,
  ChangePlan,
  PublicAuth,
  PublicMcpOccurrence,
  SnapshotResponse,
} from './types';

const AGENT_ORDER: AgentId[] = ['claude', 'codex', 'droid', 'amp', 'opencode', 'pi'];

const DOCS: Record<AgentId, string> = {
  claude: 'https://code.claude.com/docs/en/mcp',
  codex: 'https://developers.openai.com/codex/mcp/',
  droid: 'https://docs.factory.ai/cli/configuration/mcp',
  amp: 'https://ampcode.com/manual#mcp-servers',
  opencode: 'https://opencode.ai/docs/mcp-servers/',
  pi: 'https://github.com/nicobailon/pi-mcp-adapter',
};

interface MatrixVariant {
  id: string;
  occurrences: Map<AgentId, PublicMcpOccurrence[]>;
  representative: PublicMcpOccurrence;
  divergent: boolean;
}

interface MatrixRow {
  id: string;
  displayName: string;
  occurrences: Map<AgentId, PublicMcpOccurrence[]>;
  representative: PublicMcpOccurrence;
  variants: MatrixVariant[];
  divergent: boolean;
  nameCollision: boolean;
}

interface Selection {
  rowId?: string;
  occurrenceId?: string;
  compareOccurrenceId?: string;
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
  if (id === 'pi') return <LobeIcon size={size} url={piIcon} />;
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
    const values = groups.get(occurrence.familyFingerprint) ?? [];
    values.push(occurrence);
    groups.set(occurrence.familyFingerprint, values);
  }
  const namesByFamily = new Map<string, Set<string>>();
  for (const [family, values] of groups) {
    for (const value of values) {
      const normalized = value.name.toLocaleLowerCase();
      const families = namesByFamily.get(normalized) ?? new Set<string>();
      families.add(family);
      namesByFamily.set(normalized, families);
    }
  }

  return [...groups.entries()]
    .map(([family, values]) => {
      const nameCounts = new Map<string, number>();
      for (const value of values) nameCounts.set(value.name, (nameCounts.get(value.name) ?? 0) + 1);
      const displayName = [...nameCounts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0][0];
      const identityGroups = new Map<string, PublicMcpOccurrence[]>();
      for (const value of values) {
        const identityValues = identityGroups.get(value.identityFingerprint) ?? [];
        identityValues.push(value);
        identityGroups.set(value.identityFingerprint, identityValues);
      }
      const variants = [...identityGroups.entries()]
        .map(([identity, identityValues]) => {
          const identityOccurrences = new Map<AgentId, PublicMcpOccurrence[]>();
          for (const value of identityValues) {
            const agentValues = identityOccurrences.get(value.agentId) ?? [];
            agentValues.push(value);
            identityOccurrences.set(value.agentId, agentValues);
          }
          return {
            id: identity,
            occurrences: identityOccurrences,
            representative: identityValues.find((value) => value.enabled) ?? identityValues[0],
            divergent: new Set(identityValues.map((value) => value.configFingerprint)).size > 1,
          };
        })
        .sort(
          (left, right) =>
            right.occurrences.size - left.occurrences.size ||
            left.representative.name.localeCompare(right.representative.name) ||
            left.id.localeCompare(right.id),
        );
      const occurrences = new Map<AgentId, PublicMcpOccurrence[]>();
      for (const value of values) {
        const agentValues = occurrences.get(value.agentId) ?? [];
        agentValues.push(value);
        occurrences.set(value.agentId, agentValues);
      }
      return {
        id: family,
        displayName,
        occurrences,
        representative: variants[0].representative,
        variants,
        divergent: variants.some((variant) => variant.divergent),
        nameCollision: values.some(
          (value) => (namesByFamily.get(value.name.toLocaleLowerCase())?.size ?? 0) > 1,
        ),
      };
    })
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function targetNameConflict(
  snapshot: SnapshotResponse | undefined,
  row: MatrixRow,
  targetAgentId: AgentId,
  name = row.representative.name,
): PublicMcpOccurrence | undefined {
  return snapshot?.occurrences.find(
    (occurrence) =>
      occurrence.source.effective &&
      occurrence.agentId === targetAgentId &&
      occurrence.name === name &&
      occurrence.familyFingerprint !== row.id,
  );
}

function targetExactNameConflict(
  snapshot: SnapshotResponse | undefined,
  targetAgentId: AgentId,
  source: PublicMcpOccurrence,
): PublicMcpOccurrence | undefined {
  return snapshot?.occurrences.find(
    (occurrence) =>
      occurrence.source.effective &&
      occurrence.agentId === targetAgentId &&
      occurrence.name === source.name &&
      occurrence.identityFingerprint !== source.identityFingerprint,
  );
}

function cellStatus(
  row: MatrixRow,
  occurrences: PublicMcpOccurrence[],
  conflict?: PublicMcpOccurrence,
): string {
  if (!occurrences.length) return conflict ? 'Name conflict' : 'Not configured';
  if (occurrences.length > 1) return `${occurrences.length} variants`;
  const occurrence = occurrences[0];
  if (occurrence.transport.kind === 'unknown' || occurrence.warnings.some((warning) => /missing|invalid/i.test(warning))) {
    return 'Invalid';
  }
  if (!occurrence.enabled) return 'Disabled';
  if (row.variants.length > 1) {
    const index = row.variants.findIndex((variant) => variant.id === occurrence.identityFingerprint);
    return `Variant ${index + 1} of ${row.variants.length}`;
  }
  if (row.divergent) return 'Different options';
  if (occurrence.source.scope !== 'user') return `Inherited · ${occurrence.source.scope}`;
  return 'Configured';
}

function statusClass(
  row: MatrixRow,
  occurrences: PublicMcpOccurrence[],
  conflict?: PublicMcpOccurrence,
): string {
  if (!occurrences.length) return conflict ? 'conflict' : 'empty';
  if (occurrences.length > 1) return 'variant';
  const occurrence = occurrences[0];
  if (occurrence.transport.kind === 'unknown' || occurrence.warnings.some((warning) => /missing|invalid/i.test(warning))) {
    return 'invalid';
  }
  if (!occurrence.enabled) return 'disabled';
  if (row.variants.length > 1) return 'variant';
  if (row.divergent) return 'divergent';
  if (occurrence.source.scope !== 'user') return 'inherited';
  return 'configured';
}

function StatusMark({ status }: { status: string }) {
  if (status === 'empty') return <Plus size={13} />;
  if (status === 'invalid') return <AlertTriangle size={13} />;
  if (status === 'disabled') return <Minus size={13} />;
  if (status === 'conflict') return <AlertTriangle size={13} />;
  if (status === 'variant') return <GitCompare size={13} />;
  if (status === 'divergent') return <GitCompare size={13} />;
  return <Check size={13} />;
}

function authLabel(auth: PublicAuth): string {
  if (auth.kind === 'bearer-environment') return 'Bearer from environment';
  if (auth.kind === 'header-environment') return 'Headers from environment';
  if (auth.kind === 'static-headers') return 'Static credential headers';
  if (auth.oauthMode === 'pre-registered') return 'OAuth client configured';
  if (auth.oauthMode === 'disabled') return 'OAuth disabled';
  if (auth.oauthMode === 'automatic') return 'Automatic OAuth';
  if (auth.oauthMode === 'client-managed') return 'Client-managed login';
  return 'Not applicable';
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
  const [authOccurrence, setAuthOccurrence] = useState<PublicMcpOccurrence>();

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
      [
        row.displayName,
        row.representative.transport.kind,
        ...[...row.occurrences.values()].flat().flatMap((value) => [
          value.name,
          value.transport.commandPreview ?? '',
          value.transport.endpointOrigin ?? '',
        ]),
      ]
        .join(' ')
        .toLocaleLowerCase()
        .includes(query),
    );
  }, [rows, search]);

  const selectedRow = rows.find((row) => row.id === selection.rowId);
  const selectedOccurrence = snapshot?.occurrences.find(
    (occurrence) => occurrence.occurrenceId === selection.occurrenceId,
  );
  const comparedOccurrence = snapshot?.occurrences.find(
    (occurrence) => occurrence.occurrenceId === selection.compareOccurrenceId,
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

  const requestAuthPlan = useCallback(
    async (occurrenceId: string, auth: AuthUpdate) => {
      if (!snapshot) return;
      setPlanning(true);
      setError(undefined);
      try {
        const next = await api<ChangePlan>(
          '/api/auth-plans',
          {
            method: 'POST',
            body: JSON.stringify({ workspace: snapshot.workspace, occurrenceId, auth }),
          },
          snapshot.mutationToken,
        );
        setAuthOccurrence(undefined);
        setPlan(next);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Unable to create an authentication preview.');
      } finally {
        setPlanning(false);
      }
    },
    [snapshot],
  );

  const selectCell = (row: MatrixRow, agentId: AgentId) => {
    const occurrences = row.occurrences.get(agentId) ?? [];
    if (occurrences.length === 1) {
      setSelection({ rowId: row.id, occurrenceId: occurrences[0].occurrenceId, agentId });
      return;
    }
    setSelection({ rowId: row.id, agentId });
    if (
      occurrences.length === 0 &&
      row.variants.length === 1 &&
      !targetNameConflict(snapshot, row, agentId)
    ) {
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
      setNotice({
        message:
          plan.operation === 'configure-auth'
            ? `Updated authentication for ${plan.targetName} in ${plan.targetAgentId}.`
            : `Added ${plan.targetName} to ${plan.targetAgentId}.`,
        undoToken: result.undoToken,
      });
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
    if (!draggedOccurrence || draggedOccurrence.familyFingerprint !== row.id) {
      setError('Drop onto an empty cell in the same MCP family.');
      return;
    }
    if ((row.occurrences.get(targetAgentId)?.length ?? 0) > 0) {
      setError('That agent already has a variant of this MCP family configured.');
      return;
    }
    const conflict = targetNameConflict(snapshot, row, targetAgentId, draggedOccurrence.name);
    if (conflict) {
      setSelection({ rowId: row.id, agentId: targetAgentId });
      setError(`The target name is already used by another MCP identity. Compare it before copying.`);
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
                <p>
                  {rows.length} families · {rows.reduce((count, row) => count + row.variants.length, 0)} exact variants across {AGENT_ORDER.length} agents
                </p>
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

            {snapshot && snapshot.issues.length > 0 && (
              <details className="config-issues">
                <summary>
                  <AlertTriangle size={14} />
                  <span>{snapshot.issues.length} native configuration {snapshot.issues.length === 1 ? 'file could' : 'files could'} not be read</span>
                  <small>Show details</small>
                </summary>
                <div className="config-issue-list">
                  {snapshot.issues.map((issue) => (
                    <div className="config-issue" key={`${issue.agentId}:${issue.path}`}>
                      <AgentIcon id={issue.agentId} size={14} />
                      <div><strong>{issue.agentId}</strong><code>{issue.path}</code><p>{issue.message}</p></div>
                    </div>
                  ))}
                  <button type="button" onClick={() => void scan(snapshot.workspace)} disabled={loading}>
                    <RefreshCw size={12} className={loading ? 'spin' : ''} /> Refresh
                  </button>
                </div>
              </details>
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
                          <small>
                            {row.representative.transport.kind}
                            {row.variants.length > 1 ? ` · ${row.variants.length} variants` : ''}
                          </small>
                        </span>
                        {(row.variants.length > 1 || row.divergent || row.nameCollision) && <GitCompare size={13} className="row-warning" />}
                      </button>
                      {AGENT_ORDER.map((agentId) => {
                        const occurrences = row.occurrences.get(agentId) ?? [];
                        const occurrence = occurrences.length === 1 ? occurrences[0] : undefined;
                        const conflict = occurrences.length ? undefined : targetNameConflict(snapshot, row, agentId);
                        const status = statusClass(row, occurrences, conflict);
                        const dropId = `${row.id}:${agentId}`;
                        return (
                          <button
                            className={`matrix-cell ${status} ${
                              (occurrence && selection.occurrenceId === occurrence.occurrenceId) ||
                              (!selection.occurrenceId && selection.rowId === row.id && selection.agentId === agentId)
                                ? 'selected'
                                : ''
                            } ${dragTarget === dropId ? 'drag-target' : ''}`}
                            key={agentId}
                            type="button"
                            role="gridcell"
                            draggable={Boolean(occurrence)}
                            title={
                              occurrence
                                ? `${cellStatus(row, occurrences)} — drag to copy this exact variant`
                                : conflict
                                  ? `Compare ${row.displayName} with the existing "${conflict.name}" entry`
                                  : occurrences.length > 1
                                    ? `Inspect ${occurrences.length} exact variants`
                                    : row.variants.length > 1
                                      ? `Choose an exact variant to copy to ${agentId}`
                                      : `Copy ${row.displayName} to ${agentId}`
                            }
                            onClick={() => selectCell(row, agentId)}
                            onDragStart={(event) => {
                              if (!occurrence) return;
                              event.dataTransfer.effectAllowed = 'copy';
                              event.dataTransfer.setData('application/x-mcp-occurrence', occurrence.occurrenceId);
                              event.dataTransfer.setData('text/plain', occurrence.occurrenceId);
                            }}
                            onDragOver={(event) => {
                              if (occurrences.length || conflict) return;
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
                              <strong>{cellStatus(row, occurrences, conflict)}</strong>
                              {occurrence && (occurrence.name !== row.displayName || occurrence.source.scope) && (
                                <small>
                                  {occurrence.name !== row.displayName
                                    ? occurrence.name
                                    : occurrence.source.scope}
                                </small>
                              )}
                              {occurrences.length > 1 && <small>select to compare</small>}
                              {conflict && <small>{conflict.name}</small>}
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
              <span><i className="dot variant" />Variant</span>
              <span><i className="dot conflict" />Conflict</span>
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
            comparison={comparedOccurrence}
            agent={selectedAgent}
            targetAgentId={selection.agentId}
            planning={planning}
            onCopy={requestPlan}
            onInspectOccurrence={(occurrenceId, rowId, agentId) =>
              setSelection({ occurrenceId, rowId, agentId })
            }
            onCompare={(occurrenceId, compareOccurrenceId, rowId, agentId) =>
              setSelection({ occurrenceId, compareOccurrenceId, rowId, agentId })
            }
            onConfigureAuth={setAuthOccurrence}
          />
        </div>
      </div>

      {plan && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => !applying && setPlan(undefined)}>
          <section className="diff-modal" role="dialog" aria-modal="true" aria-labelledby="diff-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <span className="eyebrow">Dry run</span>
                <h2 id="diff-title">{plan.operation === 'configure-auth' ? 'Update authentication for' : 'Add'} {plan.targetName}</h2>
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

      {authOccurrence && snapshot && (
        <AuthEditor
          occurrence={authOccurrence}
          agent={snapshot.agents.find((value) => value.id === authOccurrence.agentId)!}
          planning={planning}
          onClose={() => setAuthOccurrence(undefined)}
          onPreview={(auth) => requestAuthPlan(authOccurrence.occurrenceId, auth)}
        />
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
  comparison,
  agent,
  targetAgentId,
  planning,
  onCopy,
  onInspectOccurrence,
  onCompare,
  onConfigureAuth,
}: {
  snapshot?: SnapshotResponse;
  row?: MatrixRow;
  occurrence?: PublicMcpOccurrence;
  comparison?: PublicMcpOccurrence;
  agent?: AgentSnapshot;
  targetAgentId?: AgentId;
  planning: boolean;
  onCopy: (occurrenceId: string, targetAgentId: AgentId) => Promise<void>;
  onInspectOccurrence: (occurrenceId: string, rowId: string, agentId: AgentId) => void;
  onCompare: (
    occurrenceId: string,
    compareOccurrenceId: string,
    rowId: string,
    agentId: AgentId,
  ) => void;
  onConfigureAuth: (occurrence: PublicMcpOccurrence) => void;
}) {
  if (occurrence && comparison) {
    const cards = [
      { label: 'Selected variant', value: occurrence },
      { label: 'Existing target', value: comparison },
    ];
    return (
      <aside className="inspector-panel">
        <div className="inspector-header">
          <span className="inspector-icon conflict-icon"><GitCompare size={18} /></span>
          <div><h2>Name conflict</h2><p>Compare exact MCP identities</p></div>
        </div>
        <div className="comparison-summary">
          <span className={occurrence.familyFingerprint === comparison.familyFingerprint ? 'same' : 'different'}>
            {occurrence.familyFingerprint === comparison.familyFingerprint ? 'Same family' : 'Different families'}
          </span>
          <strong>Exact identities differ</strong>
          <p>No configuration will be overwritten. Choose another name or reconcile the native entries manually.</p>
        </div>
        <div className="comparison-list">
          {cards.map(({ label, value }) => {
            const endpoint = value.transport.endpointOrigin
              ? `${value.transport.endpointOrigin}${value.transport.endpointPath ?? ''}`
              : undefined;
            return (
              <div className="comparison-card" key={`${label}:${value.occurrenceId}`}>
                <header><span>{label}</span><AgentIcon id={value.agentId} size={15} /></header>
                <strong>{value.name}</strong>
                <small>{value.agentId} · {value.transport.kind}</small>
                {value.transport.commandPreview && <code>{value.transport.commandPreview}</code>}
                {endpoint && <code>{endpoint}</code>}
                {value.transport.queryKeys.length > 0 && <p>Query: {value.transport.queryKeys.join(', ')} · values hidden</p>}
                <div><span>Exact</span><code>{value.identityFingerprint.slice(0, 16)}</code></div>
                <div><span>Config</span><code>{value.configFingerprint.slice(0, 16)}</code></div>
                <button type="button" onClick={() => onInspectOccurrence(value.occurrenceId, value.familyFingerprint, value.agentId)}>
                  Inspect entry <ArrowRight size={11} />
                </button>
              </div>
            );
          })}
        </div>
      </aside>
    );
  }

  if (occurrence) {
    const shadowed = snapshot?.occurrences.filter(
      (value) => value.agentId === occurrence.agentId && value.name === occurrence.name && !value.source.effective,
    ).length ?? 0;
    const copyTargets = AGENT_ORDER.filter(
      (target) =>
        target !== occurrence.agentId &&
        !snapshot?.occurrences.some(
          (value) =>
            value.source.effective &&
            value.agentId === target &&
            value.identityFingerprint === occurrence.identityFingerprint,
        ),
    );
    const endpoint = occurrence.transport.endpointOrigin
      ? `${occurrence.transport.endpointOrigin}${occurrence.transport.endpointPath ?? ''}`
      : undefined;
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
        {endpoint && <InspectorField label="Endpoint"><code>{endpoint}</code></InspectorField>}
        {occurrence.transport.queryKeys.length > 0 && (
          <InspectorField label="Query shape">
            <div className="tag-list">{occurrence.transport.queryKeys.map((key) => <span key={key}>{key}</span>)}</div>
            {occurrence.transport.queryValueFingerprint && <small>Values hidden · equality {occurrence.transport.queryValueFingerprint}</small>}
          </InspectorField>
        )}
        {occurrence.transport.envKeys.length > 0 && <InspectorField label="Environment"><div className="tag-list">{occurrence.transport.envKeys.map((key) => <span key={key}>{key}=••••</span>)}</div></InspectorField>}
        {occurrence.transport.headerKeys.length > 0 && <InspectorField label="Headers"><div className="tag-list">{occurrence.transport.headerKeys.map((key) => <span key={key}>{key}: ••••</span>)}</div></InspectorField>}
        <InspectorField label="Authentication">
          <div className="auth-summary">
            <span className="auth-pill"><KeyRound size={11} />{authLabel(occurrence.auth)}</span>
            {occurrence.auth.environmentVariables.length > 0 && (
              <div className="tag-list">
                {occurrence.auth.environmentVariables.map((name) => <span key={name}>{name}</span>)}
              </div>
            )}
            {occurrence.auth.oauthMode === 'automatic' && (
              <small>Configuration policy only. Each agent keeps its own login session.</small>
            )}
            {occurrence.auth.kind === 'static-headers' && (
              <small>Literal credentials are not portable and are never copied into another agent.</small>
            )}
            {occurrence.transport.kind !== 'stdio' &&
              occurrence.transport.kind !== 'unknown' &&
              (occurrence.source.scope === 'user' || occurrence.source.scope === 'local') && (
              <button className="auth-configure" type="button" onClick={() => onConfigureAuth(occurrence)}>
                Configure authentication <ArrowRight size={11} />
              </button>
            )}
            {occurrence.transport.kind !== 'stdio' &&
              occurrence.transport.kind !== 'unknown' &&
              occurrence.source.scope !== 'user' &&
              occurrence.source.scope !== 'local' && (
                <small>Authentication changes are limited to private user and local configuration layers.</small>
              )}
          </div>
        </InspectorField>
        <InspectorField label="Fingerprints">
          <div className="fingerprint-list">
            <span>Family <code>{occurrence.familyFingerprint.slice(0, 16)}</code></span>
            <span>Exact <code>{occurrence.identityFingerprint.slice(0, 16)}</code></span>
            <span>Config <code>{occurrence.configFingerprint.slice(0, 16)}</code></span>
          </div>
        </InspectorField>
        {row && row.variants.length > 1 && (
          <div className="inspector-warning"><GitCompare size={13} /><p>This family has {row.variants.length} exact variants. Copy and conflict checks still use the selected exact identity.</p></div>
        )}
        {occurrence.warnings.length > 0 && <div className="inspector-warning"><AlertTriangle size={13} /><div>{occurrence.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div></div>}
        <div className="inspector-section copy-section">
          <h3>Copy configuration</h3>
          <p>Copy this exact variant. Existing names and identities are never overwritten.</p>
          <div className="copy-targets">
            {copyTargets.map((target) => {
              const conflict = targetExactNameConflict(snapshot, target, occurrence);
              return conflict ? (
                <button
                  className="conflict-action"
                  type="button"
                  key={target}
                  onClick={() => onCompare(occurrence.occurrenceId, conflict.occurrenceId, occurrence.familyFingerprint, target)}
                >
                  <AgentIcon id={target} size={15} /><span>{target} · compare</span><GitCompare size={12} />
                </button>
              ) : (
                <button type="button" key={target} disabled={planning} onClick={() => void onCopy(occurrence.occurrenceId, target)}>
                  <AgentIcon id={target} size={15} /><span>{target}</span><ArrowRight size={12} />
                </button>
              );
            })}
          </div>
          {copyTargets.length === 0 && <p className="copy-complete">This exact identity is already present in every supported agent.</p>}
        </div>
      </aside>
    );
  }

  if (row) {
    return (
      <aside className="inspector-panel">
        <div className="inspector-header">
          <span className="inspector-icon"><MCP size={18} /></span>
          <div><h2>{row.displayName}</h2><p>MCP family · {row.variants.length} exact {row.variants.length === 1 ? 'variant' : 'variants'}</p></div>
        </div>
        <div className="coverage-strip">
          {AGENT_ORDER.map((agentId) => <i className={row.occurrences.has(agentId) ? 'covered' : ''} key={agentId} />)}
        </div>
        <InspectorField label="Coverage"><strong>{row.occurrences.size} / {AGENT_ORDER.length} agents</strong></InspectorField>
        <InspectorField label="Transport"><code>{row.representative.transport.kind}</code></InspectorField>
        <InspectorField label="Family"><code>{row.id.slice(0, 16)}</code></InspectorField>
        {(row.variants.length > 1 || row.divergent || row.nameCollision) && (
          <div className="inspector-warning">
            <GitCompare size={13} />
            <p>
              {row.nameCollision
                ? 'The same name is also used by another MCP family.'
                : row.variants.length > 1
                  ? 'This family contains multiple exact launch or endpoint variants. They are grouped for navigation, never for overwrite decisions.'
                  : 'Portable options differ between agents.'}
            </p>
          </div>
        )}
        <div className="inspector-section copy-section">
          <h3>{targetAgentId ? `Choose a variant for ${targetAgentId}` : 'Exact variants'}</h3>
          <p>{targetAgentId ? 'Select the exact definition to add or compare.' : 'Select a variant to inspect its native definition and distribution options.'}</p>
          <div className="variant-list">
            {row.variants.map((variant, index) => {
              const source = variant.representative;
              const existing = targetAgentId ? variant.occurrences.get(targetAgentId)?.[0] : undefined;
              const conflict = targetAgentId
                ? targetExactNameConflict(snapshot, targetAgentId, source)
                : undefined;
              const agents = [...variant.occurrences.keys()].join(', ');
              return (
                <div className="variant-card" key={variant.id}>
                  <button
                    className="variant-details"
                    type="button"
                    onClick={() => onInspectOccurrence(source.occurrenceId, row.id, source.agentId)}
                  >
                    <span>Variant {index + 1}</span>
                    <code>{variant.id.slice(0, 10)}</code>
                    <small>{agents || source.agentId}</small>
                  </button>
                  {targetAgentId && (
                    existing ? (
                      <button className="variant-action present" type="button" onClick={() => onInspectOccurrence(existing.occurrenceId, row.id, targetAgentId)}>
                        <Check size={12} /> Present
                      </button>
                    ) : conflict ? (
                      <button className="variant-action conflict-action" type="button" onClick={() => onCompare(source.occurrenceId, conflict.occurrenceId, row.id, targetAgentId)}>
                        <GitCompare size={12} /> Compare
                      </button>
                    ) : (
                      <button className="variant-action" type="button" disabled={planning} onClick={() => void onCopy(source.occurrenceId, targetAgentId)}>
                        <Plus size={12} /> Add
                      </button>
                    )
                  )}
                </div>
              );
            })}
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
        <a className="docs-link" href={DOCS[agent.id]} target="_blank" rel="noreferrer">
          {agent.id === 'pi' ? 'pi-mcp-adapter documentation' : 'Official MCP documentation'} <ExternalLink size={12} />
        </a>
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

function initialAuthKind(auth: PublicAuth): AuthUpdate['kind'] {
  if (auth.kind === 'bearer-environment') return 'bearer-environment';
  if (auth.kind === 'header-environment') return 'header-environment';
  if (auth.oauthMode === 'pre-registered') return 'oauth-client';
  if (auth.oauthMode === 'disabled') return 'oauth-disabled';
  return 'automatic-oauth';
}

function AuthEditor({
  occurrence,
  agent,
  planning,
  onClose,
  onPreview,
}: {
  occurrence: PublicMcpOccurrence;
  agent: AgentSnapshot;
  planning: boolean;
  onClose: () => void;
  onPreview: (auth: AuthUpdate) => Promise<void>;
}) {
  const capabilities = agent.authCapabilities;
  const supportedKinds = useMemo(() => {
    const values: AuthUpdate['kind'][] = [];
    if (capabilities.automaticOAuth) values.push('automatic-oauth');
    if (capabilities.bearerEnvironment) values.push('bearer-environment');
    if (capabilities.customHeaderEnvironment) values.push('header-environment');
    if (capabilities.preRegisteredOAuth === 'native-config') values.push('oauth-client');
    if (capabilities.oauthDisabled) values.push('oauth-disabled');
    return values;
  }, [capabilities]);
  const currentKind = initialAuthKind(occurrence.auth);
  const [kind, setKind] = useState<AuthUpdate['kind']>(
    supportedKinds.includes(currentKind) ? currentKind : supportedKinds[0],
  );
  const [environmentVariable, setEnvironmentVariable] = useState(
    occurrence.auth.environmentVariables[0] ?? '',
  );
  const [headerName, setHeaderName] = useState('X-API-Key');
  const [prefix, setPrefix] = useState('');
  const [issuer, setIssuer] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecretEnvironmentVariable, setClientSecretEnvironmentVariable] = useState('');
  const [scopes, setScopes] = useState('');
  const [callbackPort, setCallbackPort] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsedScopes = scopes.split(',').map((scope) => scope.trim()).filter(Boolean);
    let auth: AuthUpdate;
    if (kind === 'bearer-environment') {
      auth = { kind, environmentVariable };
    } else if (kind === 'header-environment') {
      auth = { kind, headerName, environmentVariable, prefix: prefix || undefined };
    } else if (kind === 'oauth-client') {
      auth = {
        kind,
        authorizationServerIssuer: issuer || undefined,
        clientId,
        clientSecretEnvironmentVariable: clientSecretEnvironmentVariable || undefined,
        scopes: parsedScopes.length ? parsedScopes : undefined,
        callbackPort: callbackPort ? Number(callbackPort) : undefined,
      };
    } else if (kind === 'automatic-oauth') {
      auth = { kind, scopes: parsedScopes.length ? parsedScopes : undefined };
    } else {
      auth = { kind };
    }
    void onPreview(auth);
  };

  const labels: Record<AuthUpdate['kind'], string> = {
    'automatic-oauth': 'Automatic OAuth',
    'bearer-environment': 'Bearer token from environment',
    'header-environment': 'Custom header from environment',
    'oauth-client': 'Pre-registered OAuth client',
    'oauth-disabled': 'No authentication',
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={() => !planning && onClose()}>
      <form className="auth-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span className="eyebrow">Native configuration</span>
            <h2>Authentication for {occurrence.name}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} disabled={planning}><X size={15} /></button>
        </header>
        <div className="auth-route">
          <span className="agent-token"><AgentIcon id={agent.id} size={16} />{agent.name}</span>
          <code>{occurrence.source.path}</code>
        </div>
        <div className="auth-form">
          <label>
            <span>Strategy</span>
            <select value={kind} onChange={(event) => setKind(event.target.value as AuthUpdate['kind'])}>
              {supportedKinds.map((value) => <option value={value} key={value}>{labels[value]}</option>)}
            </select>
          </label>

          {kind === 'automatic-oauth' && (
            <p className="form-note">The agent performs its own OAuth flow and stores its own session. MCP Matrix never reads or transfers that session.</p>
          )}

          {(kind === 'bearer-environment' || kind === 'header-environment') && (
            <TextField label="Environment variable" value={environmentVariable} onChange={setEnvironmentVariable} placeholder="MCP_API_TOKEN" required />
          )}
          {kind === 'bearer-environment' && (
            <p className="form-note">Writes a Bearer Authorization header backed by the named environment variable. No token value enters this app.</p>
          )}
          {kind === 'header-environment' && (
            <>
              <TextField label="Header name" value={headerName} onChange={setHeaderName} placeholder="X-API-Key" required />
              <TextField label="Value prefix (optional)" value={prefix} onChange={setPrefix} placeholder="Bearer " />
            </>
          )}

          {kind === 'oauth-client' && (
            <>
              <TextField label={`Authorization server issuer${agent.id === 'droid' ? '' : ' (optional)'}`} value={issuer} onChange={setIssuer} placeholder="https://auth.example.com/" required={agent.id === 'droid'} />
              <TextField label="Client ID" value={clientId} onChange={setClientId} required />
              {(agent.id === 'opencode' || agent.id === 'pi') && <TextField label="Client secret environment variable (optional)" value={clientSecretEnvironmentVariable} onChange={setClientSecretEnvironmentVariable} placeholder="MCP_CLIENT_SECRET" />}
              <TextField label="Scopes (comma-separated)" value={scopes} onChange={setScopes} placeholder="read, write" />
              {(agent.id === 'droid' || agent.id === 'claude') && <TextField label="Callback port (optional)" value={callbackPort} onChange={setCallbackPort} inputMode="numeric" />}
              <p className="form-note">Only client metadata{agent.id === 'opencode' || agent.id === 'pi' ? ' and an optional secret environment-variable name are' : ' is'} written. Literal client secrets cannot be entered here.</p>
            </>
          )}

          {kind === 'oauth-disabled' && (
            <p className="form-note">Disables automatic OAuth for this server where the agent supports an explicit native switch.</p>
          )}
        </div>
        <footer>
          <div className="safety-copy"><ShieldCheck size={14} /><span>Preview first. Secret values stay outside MCP Matrix.</span></div>
          <button className="button secondary" type="button" onClick={onClose} disabled={planning}>Cancel</button>
          <button className="button primary" type="submit" disabled={planning}>
            {planning ? <RefreshCw size={13} className="spin" /> : <FileCode2 size={13} />}
            Preview patch
          </button>
        </footer>
      </form>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  required,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  inputMode?: 'numeric';
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required={required}
        inputMode={inputMode}
        autoComplete="off"
        spellCheck={false}
      />
    </label>
  );
}

function InspectorField({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="inspector-field"><span className="field-label">{label}</span><div>{children}</div></div>;
}

export default App;
