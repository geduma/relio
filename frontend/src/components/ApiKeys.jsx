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
  const [newKey, setNewKey] = useState(null)
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
      if (data.key) setKeys(prev => [data.key, ...prev])
      toast('API key created', 'success')
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  async function handleCopy() {
    if (!newKey) return
    try {
      await navigator.clipboard.writeText(newKey)
      toast('API key copied to clipboard', 'success')
    } catch {
      toast('Could not copy to clipboard', 'error')
    }
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
          <strong>Save this key {`\u2014`} it won&apos;t be shown again:</strong>
          <div className="key-reveal">
            <code>{newKey}</code>
            <button type="button" className="btn btn-sm" onClick={handleCopy}>
              Copy
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setNewKey(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <form onSubmit={handleCreate} className="form-inline">
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Key name (e.g. Production App)"
          required
        />
        <button type="submit" className="btn btn-primary" disabled={selectedProviderIds.length === 0}>
          Create New Key
        </button>
      </form>

      <div className="form-section">
        <label className="form-label">Providers with access</label>
        <ProviderSelect
          providers={providers}
          selected={selectedProviderIds}
          onChange={setSelectedProviderIds}
        />
      </div>

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
              <td data-label="Actions">
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
