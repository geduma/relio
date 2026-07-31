import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useToast, errorMessage } from './Toast.jsx'

const TYPE_LABELS = {
  'openai-compatible': 'OpenAI Compatible',
  'anthropic': 'Anthropic',
  'gemini-native': 'Gemini',
  'azure-openai': 'Azure',
}

export default function ProvidersList() {
  const [providers, setProviders] = useState([])
  const [filter, setFilter] = useState('')
  const [deleteTarget, setDeleteTarget] = useState(null)
  const toast = useToast()

  useEffect(() => {
    const query = filter ? `?capability=${filter}` : ''
    fetch(`/admin/api/providers${query}`)
      .then(async r => {
        if (!r.ok) throw new Error(`Failed to load providers (${r.status})`)
        return r.json()
      })
      .then(setProviders)
      .catch(err => toast(errorMessage(err), 'error'))
  }, [filter])

  async function handleDelete(id) {
    const res = await fetch(`/admin/api/providers/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      toast(errorMessage(data.error || 'Failed to delete provider'), 'error')
      return
    }
    setProviders(prev => prev.filter(p => p.id !== id))
    toast('Provider deleted', 'success')
  }

  const activeProviders = providers.filter(p => p.status !== 'paused')

  async function handleReorder(dragId, targetId) {
    const ids = activeProviders.map(p => p.id)
    const dragIdx = ids.indexOf(dragId)
    const targetIdx = ids.indexOf(targetId)
    ids.splice(dragIdx, 1)
    ids.splice(targetIdx, 0, dragId)

    const res = await fetch('/admin/api/providers/reorder', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider_ids: ids }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      toast(errorMessage(data.error || 'Failed to reorder providers'), 'error')
      return
    }

    setProviders(prev => {
      const map = Object.fromEntries(prev.map(p => [p.id, p]))
      const reordered = ids.map((id, i) => ({
        ...map[id],
        order_position: i,
        order_label: ['Main', 'Fallback 1', 'Fallback 2', 'Fallback 3', 'Fallback 4'][i] || `Fallback ${i}`,
      }))
      const pausedOnes = prev.filter(p => p.status === 'paused')
      return [...reordered, ...pausedOnes]
    })
  }

  return (
    <div>
      <div className="header-row">
        <h2>Providers</h2>
        <Link to="/admin/providers/new" className="btn btn-primary">
          + Add Provider
        </Link>
      </div>
      <div className="filter-bar">
        <select value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="">All capabilities</option>
          <option value="chat">Chat</option>
          <option value="embeddings">Embeddings</option>
        </select>
      </div>
      <div className="table-wrapper"><table className="table">
        <thead>
          <tr>
            <th>Order</th>
            <th>Name</th>
            <th>Model</th>
            <th>Type</th>
            <th>Capability</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {activeProviders.map((p, i) => (
            <tr key={p.id}>
              <td>
                <span className="order-label">{p.order_label}</span>
                <div className="order-arrows">
                  <button
                    disabled={i === 0}
                    onClick={() => handleReorder(p.id, activeProviders[i - 1]?.id)}
                  >&#9650;</button>
                  <button
                    disabled={i === activeProviders.length - 1}
                    onClick={() => handleReorder(p.id, activeProviders[i + 1]?.id)}
                  >&#9660;</button>
                </div>
              </td>
              <td>{p.name}</td>
              <td>{p.model}</td>
              <td>{TYPE_LABELS[p.provider_type] || p.provider_type || 'OpenAI Compatible'}</td>
              <td><span className={`badge badge-${p.capability || 'chat'}`}>{p.capability || 'chat'}</span></td>
              <td><span className={`badge badge-${p.status}`}>{p.status}</span></td>
              <td>
                <div className="actions-cell">
                  <Link to={`/admin/providers/${p.id}/edit`} className="btn btn-sm">Edit</Link>
                  {p.order_label === 'Main' && p.status !== 'paused' ? (
                    <span className="btn btn-sm btn-disabled" title="Move to a fallback position first">Delete</span>
                  ) : (
                    <button className="btn btn-sm btn-danger" onClick={() => setDeleteTarget(p.id)}>Delete</button>
                  )}
                </div>
              </td>
            </tr>
          ))}
          {providers.filter(p => p.status === 'paused').map(p => (
            <tr key={p.id} className="row-paused">
              <td><span className="order-label">--</span></td>
              <td>{p.name}</td>
              <td>{p.model}</td>
              <td>{TYPE_LABELS[p.provider_type] || p.provider_type || 'OpenAI Compatible'}</td>
              <td><span className={`badge badge-${p.capability || 'chat'}`}>{p.capability || 'chat'}</span></td>
              <td><span className={`badge badge-${p.status}`}>{p.status}</span></td>
              <td>
                <div className="actions-cell">
                  <Link to={`/admin/providers/${p.id}/edit`} className="btn btn-sm">Edit</Link>
                  <button className="btn btn-sm btn-danger" onClick={() => setDeleteTarget(p.id)}>Delete</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>

      {deleteTarget && (
        <div className="modal-overlay" onClick={() => setDeleteTarget(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Delete provider</h3>
            <p>Are you sure you want to delete this provider?</p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button className="btn btn-danger" onClick={() => { handleDelete(deleteTarget); setDeleteTarget(null) }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
