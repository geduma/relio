import { useState, useEffect } from 'react'
import { useToast, errorMessage } from './Toast.jsx'
import Pagination, { usePagination } from './Pagination.jsx'

function parseDate(dateStr) {
  if (!dateStr) return null
  if (dateStr.endsWith('Z') || dateStr.includes('+') || dateStr.includes('T')) {
    return new Date(dateStr)
  }
  return new Date(dateStr.replace(' ', 'T') + 'Z')
}

const NEW_KEY_TTL = 60

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

function ProviderSelect({ providers, selected, onChange }) {
  function toggle(id) {
    onChange(
      selected.includes(id)
        ? selected.filter(x => x !== id)
        : [...selected, id]
    )
  }

  return (
    <div className="provider-select">
      {providers.map(p => (
        <label key={p.id} className="provider-select-option">
          <input
            type="checkbox"
            checked={selected.includes(p.id)}
            onChange={() => toggle(p.id)}
          />
          <span>{p.name}</span>
          <span className={`badge badge-${p.capability}`}>{p.capability}</span>
        </label>
      ))}
      {providers.length === 0 && (
        <p className="text-muted">No providers configured. Create one first.</p>
      )}
    </div>
  )
}

export default function ApiKeys() {
  const [keys, setKeys] = useState([])
  const [providers, setProviders] = useState([])
  const [name, setName] = useState('')
  const [selectedProviderIds, setSelectedProviderIds] = useState([])
  const [createOpen, setCreateOpen] = useState(false)
  const [newKey, setNewKey] = useState(null)
  const [countdown, setCountdown] = useState(0)
  const [editTarget, setEditTarget] = useState(null) // { id, name, providerIds }
  const [editProviderIds, setEditProviderIds] = useState([])
  const [revokeTarget, setRevokeTarget] = useState(null) // { id, name }
  const toast = useToast()
  const { page, pageSize, totalPages, pageRows, setPage, setPageSize } = usePagination(keys)

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      fetch('/admin/api/keys', { signal: controller.signal }).then(r => {
        if (!r.ok) throw new Error(`Failed to load keys (${r.status})`)
        return r.json()
      }),
      fetch('/admin/api/providers', { signal: controller.signal }).then(r => {
        if (!r.ok) throw new Error(`Failed to load providers (${r.status})`)
        return r.json()
      }),
    ])
      .then(([keyData, providerData]) => {
        setKeys(keyData)
        setProviders(providerData)
      })
      .catch(err => {
        if (err.name !== 'AbortError') toast(errorMessage(err), 'error')
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!newKey) {
      setCountdown(0)
      return
    }
    setCountdown(NEW_KEY_TTL)
    const iv = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) {
          clearInterval(iv)
          setNewKey(null)
          return 0
        }
        return c - 1
      })
    }, 1000)
    return () => clearInterval(iv)
  }, [newKey])

  async function handleCreate(e) {
    e.preventDefault()
    if (selectedProviderIds.length === 0) {
      toast('Select at least one provider', 'error')
      return
    }
    try {
      const res = await fetch('/admin/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, providerIds: selectedProviderIds }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast(errorMessage(data.error || 'Failed to create key'), 'error')
        return
      }
      setNewKey(data.apiKey)
      setName('')
      setSelectedProviderIds([])
      setCreateOpen(false)
      if (data.key) setKeys(prev => [data.key, ...prev])
      toast('API key created', 'success')
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  async function handleCopy() {
    if (!newKey) return
    const ok = await copyToClipboard(newKey)
    toast(ok ? 'API key copied to clipboard' : 'Could not copy to clipboard', ok ? 'success' : 'error')
  }

  async function handleEdit(e) {
    e.preventDefault()
    if (editProviderIds.length === 0) {
      toast('Select at least one provider', 'error')
      return
    }
    try {
      const res = await fetch(`/admin/api/keys/${editTarget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerIds: editProviderIds }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast(errorMessage(data.error || 'Failed to update providers'), 'error')
        return
      }
      setKeys(prev => prev.map(k => (k.id === editTarget.id ? data : k)))
      setEditTarget(null)
      toast('Providers updated', 'success')
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  async function handleRevoke(id) {
    const res = await fetch(`/admin/api/keys/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      toast(errorMessage(data.error || 'Failed to revoke key'), 'error')
      return
    }
    setKeys(prev => prev.filter(k => k.id !== id))
    toast('API key revoked', 'success')
  }

  function openEdit(k) {
    setEditTarget(k)
    setEditProviderIds(k.providers ? k.providers.map(p => p.id) : [])
  }

  return (
    <div>
      <h2>API Keys</h2>

      {newKey && (
        <div className="alert alert-warning">
          <div className="key-alert-head">
            <strong>Save this key {`\u2014`} it won&apos;t be shown again:</strong>
            <span className="key-countdown">Auto-dismiss in {countdown}s</span>
          </div>
          <div className="key-reveal">
            <code>{newKey}</code>
            <button
              type="button"
              className="btn btn-sm btn-icon"
              onClick={handleCopy}
              title="Copy"
              aria-label="Copy API key"
            >
              <svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setNewKey(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <form
        onSubmit={e => { e.preventDefault(); setCreateOpen(true) }}
        className="form-inline"
      >
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Key name (e.g. Production App)"
          required
        />
        <button type="submit" className="btn btn-primary">
          Create New Key
        </button>
      </form>

      {createOpen && (
        <div className="modal-overlay" onClick={() => setCreateOpen(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Create new API key</h3>
            <p>Select the providers this key can access.</p>
            <form onSubmit={handleCreate}>
              <ProviderSelect
                providers={providers}
                selected={selectedProviderIds}
                onChange={setSelectedProviderIds}
              />
              <div className="modal-actions">
                <button type="button" className="btn" onClick={() => setCreateOpen(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={selectedProviderIds.length === 0}>Create Key</button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="table-wrapper"><table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Key</th>
            <th>Providers</th>
            <th>Created</th>
            <th>Last Used</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {pageRows.map(k => (
            <tr key={k.id}>
              <td data-label="Name">{k.name}</td>
              <td data-label="Key"><code>{k.key_preview}</code></td>
              <td data-label="Providers">
                {k.providers && k.providers.length > 0 ? (
                  <div className="provider-chips">
                    {k.providers.map(p => (
                      <span key={p.id} className={`badge badge-${p.capability}`}>{p.name}</span>
                    ))}
                  </div>
                ) : (
                  <span className="text-muted">-</span>
                )}
              </td>
              <td data-label="Created">{parseDate(k.created_at)?.toLocaleDateString() || '-'}</td>
              <td data-label="Last Used">{parseDate(k.last_used_at)?.toLocaleDateString() || '-'}</td>
              <td data-label="Actions" className="actions-cell">
                <button className="btn btn-sm" onClick={() => openEdit(k)}>
                  Edit Providers
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => setRevokeTarget(k)}>
                  Revoke
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <Pagination
        page={page}
        pageSize={pageSize}
        total={keys.length}
        totalPages={totalPages}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />

      {editTarget && (
        <div className="modal-overlay" onClick={() => setEditTarget(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Edit providers for {editTarget.name}</h3>
            <form onSubmit={handleEdit}>
              <ProviderSelect
                providers={providers}
                selected={editProviderIds}
                onChange={setEditProviderIds}
              />
              <div className="modal-actions">
                <button type="button" className="btn" onClick={() => setEditTarget(null)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={editProviderIds.length === 0}>Save</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {revokeTarget && (
        <div className="modal-overlay" onClick={() => setRevokeTarget(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Revoke API key</h3>
            <p>Revoke API key <strong>{revokeTarget.name}</strong>? This action cannot be undone.</p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setRevokeTarget(null)}>Cancel</button>
              <button className="btn btn-danger" onClick={() => { handleRevoke(revokeTarget.id); setRevokeTarget(null) }}>Revoke</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
