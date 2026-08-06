import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

export default function RowActions({ actions }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, right: 0 })
  const toggleRef = useRef(null)
  const menuRef = useRef(null)

  function toggleMenu() {
    if (open) {
      setOpen(false)
      return
    }
    const rect = toggleRef.current.getBoundingClientRect()
    setPos({
      top: rect.bottom + 4,
      right: Math.max(window.innerWidth - rect.right, 8),
    })
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    function onPointerDown(e) {
      if (toggleRef.current?.contains(e.target)) return
      if (menuRef.current?.contains(e.target)) return
      setOpen(false)
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') setOpen(false)
    }
    function onScroll() { setOpen(false) }
    function onResize() { setOpen(false) }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  return (
    <div className="row-actions">
      <button
        ref={toggleRef}
        type="button"
        className="row-actions-toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Actions"
        title="Actions"
        onClick={toggleMenu}
      >
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="5" r="1.9" />
          <circle cx="12" cy="12" r="1.9" />
          <circle cx="12" cy="19" r="1.9" />
        </svg>
      </button>
      {open && (
        <div className="row-actions-menu" ref={menuRef} style={{ top: pos.top, right: pos.right }} role="menu">
          {actions.map((a, i) => {
            const className = `row-actions-item${a.danger ? ' row-actions-item-danger' : ''}`
            if (a.to) {
              return (
                <Link key={i} to={a.to} role="menuitem" className={className} onClick={() => setOpen(false)}>
                  {a.label}
                </Link>
              )
            }
            return (
              <button
                key={i}
                type="button"
                role="menuitem"
                className={className}
                disabled={a.disabled}
                onClick={() => { setOpen(false); a.onClick?.() }}
              >
                {a.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
