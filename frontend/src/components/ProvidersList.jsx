import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useToast, errorMessage } from './Toast.jsx'
import Pagination, { usePagination } from './Pagination.jsx'
import RowActions from './RowActions.jsx'

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
    const controller = new AbortController()
    fetch(`/admin/api/providers${query}`, { signal: controller.signal })
      .then(async r => {
        if (!r.ok) throw new Error(`Failed to load providers (${r.status})`)
        return r.json()
      })
      .then(setProviders)
      .catch(err => { if (err.name !== 'AbortError') toast(errorMessage(err), 'error') })
    return () => controller.abort()
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
  const orderedProviders = [...providers].sort((a, b) => {
    if (a.status === 'paused' && b.status !== 'paused') return 1
    if (a.status !== 'paused' && b.status === 'paused') return -1
    return (a.order_position ?? 0) - (b.order_position ?? 0)
  })
  const { page, pageSize, totalPages, pageRows, setPage, setPageSize } = usePagination(orderedProviders)

  function sameCapabilityActive(provider) {
    return activeProviders.filter(p => p.capability === provider.capability)
  }

  async function handleReorder(dragId, targetId) {
    const dragProvider = providers.find(p => p.id === dragId)
    if (!dragProvider) return
    const ids = sameCapabilityActive(dragProvider).map(p => p.id)
    const dragIdx = ids.indexOf(dragId)
    const targetIdx = ids.indexOf(targetId)
    if (dragIdx === -1 || targetIdx === -1) return

    ids.splice(dragIdx, 1)
    ids.splice(targetIdx, 0, dragId)

    const res = await fetch('/admin/api/providers/reorder', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider_ids: ids, capability: dragProvider.capability }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      toast(errorMessage(data.error || 'Failed to reorder providers'), 'error')
      return
    }

    const orderLabels = ['Main', 'Fallback 1', 'Fallback 2', 'Fallback 3', 'Fallback 4']
    setProviders(prev => prev.map(p => {
      const idx = ids.indexOf(p.id)
      if (idx === -1) return p
      return { ...p, order_position: idx, order_label: orderLabels[idx] || `Fallback ${idx}` }
    }))
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
            <th className="actions-col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {pageRows.map(p => p.status === 'paused' ? (
            <tr key={p.id} className="row-paused">
              <td data-label="Order"><span className="order-label">--</span></td>
              <td data-label="Name">{p.name}</td>
              <td data-label="Model">{p.model}</td>
              <td data-label="Type">{TYPE_LABELS[p.provider_type] || p.provider_type || 'OpenAI Compatible'}</td>
              <td data-label="Capability"><span className={`badge badge-${p.capability || 'chat'}`}>{p.capability || 'chat'}</span></td>
              <td data-label="Status"><span className={`badge badge-${p.status}`}>{p.status}</span></td>
              <td data-label="Actions" className="actions-col">
                <RowActions
                  actions={[
                    { label: 'Edit', to: `/admin/providers/${p.id}/edit` },
                    { label: 'Delete', onClick: () => setDeleteTarget(p.id), danger: true },
                  ]}
                />
              </td>
            </tr>
          ) : (
            (() => {
              const sameCap = sameCapabilityActive(p)
              const idx = sameCap.findIndex(ap => ap.id === p.id)
              return (
                <tr key={p.id}>
                  <td data-label="Order">
                    <span className="order-label">{p.order_label}</span>
                    <div className="order-arrows">
                      <button
                        disabled={idx === 0}
                        onClick={() => handleReorder(p.id, sameCap[idx - 1]?.id)}
                      >&#9650;</button>
                      <button
                        disabled={idx === sameCap.length - 1}
                        onClick={() => handleReorder(p.id, sameCap[idx + 1]?.id)}
                      >&#9660;</button>
                    </div>
                  </td>
                  <td data-label="Name">{p.name}</td>
                  <td data-label="Model">{p.model}</td>
                  <td data-label="Type">{TYPE_LABELS[p.provider_type] || p.provider_type || 'OpenAI Compatible'}</td>
                  <td data-label="Capability"><span className={`badge badge-${p.capability || 'chat'}`}>{p.capability || 'chat'}</span></td>
                  <td data-label="Status"><span className={`badge badge-${p.status}`}>{p.status}</span></td>
                  <td data-label="Actions" className="actions-col">
                    <RowActions
                      actions={[
                        { label: 'Edit', to: `/admin/providers/${p.id}/edit` },
                        { label: 'Delete', onClick: () => setDeleteTarget(p.id), danger: true },
                      ]}
                    />
                  </td>
                </tr>
              )
            })()
          ))}
        </tbody>
      </table></div>
      <Pagination
        page={page}
        pageSize={pageSize}
        total={orderedProviders.length}
        totalPages={totalPages}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />

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
