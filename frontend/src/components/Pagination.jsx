import { useState, useEffect } from 'react'

export function usePagination(rows = []) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize))

  useEffect(() => {
    setPage(1)
  }, [rows.length])

  const safePage = Math.min(page, totalPages)
  const start = (safePage - 1) * pageSize
  return {
    page: safePage,
    pageSize,
    totalPages,
    pageRows: rows.slice(start, start + pageSize),
    setPage,
    setPageSize,
  }
}

const PAGE_SIZES = [10, 20, 50, 100]

export default function Pagination({ page, pageSize, total, totalPages, onPageChange, onPageSizeChange }) {
  if (totalPages <= 1) return null
  return (
    <div className="pagination">
      <span className="pagination-info">{total} rows</span>
      <button className="btn btn-sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>‹ Prev</button>
      <span className="pagination-info">Page {page} of {totalPages}</span>
      <button className="btn btn-sm" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>Next ›</button>
      <select value={pageSize} onChange={e => onPageSizeChange(Number(e.target.value))}>
        {PAGE_SIZES.map(size => (
          <option key={size} value={size}>{size} / page</option>
        ))}
      </select>
    </div>
  )
}
