import { useState, useEffect } from 'react'
import { useToast, errorMessage } from './Toast.jsx'
import Pagination, { usePagination, FillerRows } from './Pagination.jsx'

function parseDate(dateStr) {
  if (!dateStr) return null
  if (dateStr.endsWith('Z') || dateStr.includes('+') || dateStr.includes('T')) {
    return new Date(dateStr)
  }
  return new Date(dateStr.replace(' ', 'T') + 'Z')
}

export default function ApiKeys() {
  const [keys, setKeys] = useState([])
  const [name, setName] = useState('')
  const [newKey, setNewKey] = useState(null)
  const [revokeTarget, setRevokeTarget] = useState(null) // { id, name }
  const toast = useToast()
  const { page, pageSize, totalPages, pageRows, setPage, setPageSize } = usePagination(keys)

  useEffect(() => {
    fetch('/admin/api/keys')
      .then(async r => {
        if (!r.ok) throw new Error(`Failed to load keys (${r.status})`)
        return r.json()
      })
      .then(setKeys)
      .catch(err => toast(errorMessage(err), 'error'))
  }, [])

  async function handleCreate(e) {
    e.preventDefault()
    try {
      const res = await fetch('/admin/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast(errorMessage(data.error || 'Failed to create key'), 'error')
        return
      }
      setNewKey(data.apiKey)
      setName('')
      const updated = await fetch('/admin/api/keys')
      if (!updated.ok) throw new Error(`Failed to reload keys (${updated.status})`)
      setKeys(await updated.json())
      toast('API key created', 'success')
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

  return (
    <div>
      <h2>API Keys</h2>

      {newKey && (
        <div className="alert alert-warning">
          <strong>Save this key {`\u2014`} it won&apos;t be shown again:</strong>
          <code>{newKey}</code>
          <button className="btn btn-sm" onClick={() => setNewKey(null)}>Dismiss</button>
        </div>
      )}

      <form onSubmit={handleCreate} className="form-inline">
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Key name (e.g. Production App)"
          required
        />
        <button type="submit" className="btn btn-primary">Create New Key</button>
      </form>

      <div className="table-wrapper"><table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Key</th>
            <th>Created</th>
            <th>Last Used</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {pageRows.map(k => (
            <tr key={k.id}>
              <td>{k.name}</td>
              <td><code>{k.key_preview}</code></td>
              <td>{parseDate(k.created_at)?.toLocaleDateString() || '-'}</td>
              <td>{parseDate(k.last_used_at)?.toLocaleDateString() || '-'}</td>
              <td>
                <button className="btn btn-sm btn-danger" onClick={() => setRevokeTarget(k)}>
                  Revoke
                </button>
              </td>
            </tr>
          ))}
          <FillerRows rows={pageRows} pageSize={pageSize} colSpan={5} />
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
