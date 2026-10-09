import { useNavigate, useSearch } from '@tanstack/react-router'
import { type DragEvent, useCallback, useMemo, useRef, useState } from 'react'
import { auditEntries } from '@/lib/audit/auditJob'
import { findingsToCsv, partsToCsv } from '@/lib/audit/csv'
import type { SeverityFilter } from '@/lib/audit/schemas'
import type { AuditResult, Severity } from '@/lib/audit/types'
import { downloadText } from '@/lib/download'
import { readFilesToEntries } from '@/lib/readInput'
import './PreflightPage.scss'

type Filter = SeverityFilter

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'error', label: 'Errors' },
  { id: 'warning', label: 'Warnings' },
  { id: 'info', label: 'Info' },
]

export function PreflightPage() {
  const [result, setResult] = useState<AuditResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const search = useSearch({ from: '/' })
  const navigate = useNavigate({ from: '/' })
  const filter: Filter = search.severity ?? 'all'

  const setFilter = useCallback(
    (next: Filter) => {
      void navigate({ search: { severity: next }, replace: true })
    },
    [navigate],
  )

  const run = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      setBusy(true)
      setError(null)
      try {
        const { sourceName, entries } = await readFilesToEntries(files)
        setResult(auditEntries(sourceName, entries))
        setFilter('all')
      } catch (err) {
        setResult(null)
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [setFilter],
  )

  const findings = useMemo(() => {
    if (!result) return []
    return filter === 'all'
      ? result.findings
      : result.findings.filter((finding) => finding.severity === filter)
  }, [result, filter])

  const onDrop = useCallback(
    (event: DragEvent<HTMLButtonElement>) => {
      event.preventDefault()
      setDragging(false)
      void run(Array.from(event.dataTransfer.files))
    },
    [run],
  )

  return (
    <div className="preflight">
      <section className="intro">
        <h1>WiseCAM preflight</h1>
        <p className="muted">
          Drop a job .zip (NC + STEP + PDF, optionally a part list .xlsx). Everything is checked
          locally in your browser — nothing is uploaded.
        </p>
      </section>

      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          void run(Array.from(event.target.files ?? []))
          event.target.value = ''
        }}
      />
      <button
        type="button"
        className={`dropzone${dragging ? ' dropzone-active' : ''}${busy ? ' dropzone-busy' : ''}`}
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <span className="dropzone-title">{busy ? 'Auditing…' : 'Drop files here'}</span>
        <span className="muted">or click to browse</span>
        <span className="dropzone-hint muted">.zip · .nc1 · .stp · .pdf · .xlsx</span>
      </button>

      {error && <div className="alert alert-error">{error}</div>}

      {result && (
        <>
          <section className="summary">
            <Stat label="Parts" value={result.summary.parts} />
            <Stat label="Errors" value={result.summary.errors} tone="error" />
            <Stat label="Warnings" value={result.summary.warnings} tone="warning" />
            <Stat label="Info" value={result.summary.infos} tone="info" />
            <Stat label="Files" value={result.entriesTotal} />
            <Stat label="Part list" value={result.summary.hasPartList ? 'yes' : 'no'} />
          </section>

          <section className="results card">
            <div className="results-head">
              <h2>Findings</h2>
              <div className="results-actions">
                <div className="filters">
                  {FILTERS.map((filterOption) => (
                    <button
                      key={filterOption.id}
                      type="button"
                      className={`chip${filter === filterOption.id ? ' chip-active' : ''}`}
                      onClick={() => setFilter(filterOption.id)}
                    >
                      {filterOption.label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    downloadText(`preflight-${result.sourceName}.csv`, findingsToCsv(result))
                  }
                >
                  Export findings
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => downloadText(`parts-${result.sourceName}.csv`, partsToCsv(result))}
                >
                  Export parts
                </button>
              </div>
            </div>

            {findings.length === 0 ? (
              <p className="muted empty">Nothing to report for this filter.</p>
            ) : (
              <div className="table-scroll">
                <table className="findings">
                  <thead>
                    <tr>
                      <th>Severity</th>
                      <th>Code</th>
                      <th>Mark</th>
                      <th>Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {findings.map((finding) => (
                      <tr key={`${finding.code}-${finding.mark ?? ''}-${finding.message}`}>
                        <td>
                          <span className={`badge badge-${finding.severity}`}>
                            {finding.severity}
                          </span>
                        </td>
                        <td className="mono">{finding.code}</td>
                        <td className="mono">{finding.mark ?? '—'}</td>
                        <td>{finding.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card">
            <h2>Parts</h2>
            <div className="table-scroll">
              <table className="parts">
                <thead>
                  <tr>
                    <th>Mark</th>
                    <th>NC qty</th>
                    <th>List qty</th>
                    <th>NC len</th>
                    <th>List len</th>
                    <th>Profile</th>
                    <th>Grade</th>
                    <th>NC</th>
                    <th>STEP</th>
                    <th>PDF</th>
                  </tr>
                </thead>
                <tbody>
                  {result.parts.map((part) => (
                    <tr key={part.mark}>
                      <td className="mono">{part.mark}</td>
                      <td>{part.nc?.quantity ?? '—'}</td>
                      <td>{part.expected?.qty ?? '—'}</td>
                      <td>{part.nc?.length ?? '—'}</td>
                      <td>{part.expected?.length ?? '—'}</td>
                      <td className="mono">{part.nc?.profile ?? part.expected?.profile ?? '—'}</td>
                      <td className="mono">{part.nc?.grade ?? part.expected?.grade ?? '—'}</td>
                      <td>
                        <Status value={part.nc ? part.nc.valid : null} />
                      </td>
                      <td>
                        <Status value={part.step ? part.step.valid : null} />
                      </td>
                      <td>
                        <Status value={part.pdf ? part.pdf.valid : null} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: Severity }) {
  return (
    <div className={`stat${tone ? ` stat-${tone}` : ''}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  )
}

function Status({ value }: { value: boolean | null }) {
  if (value === null) return <span className="badge badge-missing">missing</span>
  return (
    <span className={`badge ${value ? 'badge-ok' : 'badge-error'}`}>{value ? 'ok' : 'bad'}</span>
  )
}
