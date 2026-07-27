import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

export default function Login() {
  const [loginConfig, setLoginConfig] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [loggingIn, setLoggingIn] = useState(false)
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  useEffect(() => {
    const urlError = searchParams.get('error')
    if (urlError) setError(urlError)

    const hash = window.location.hash
    if (hash && hash.includes('session_token=')) {
      const sessionToken = hash.split('session_token=')[1].split('&')[0]
      window.location.hash = ''
      finishLogin(sessionToken)
      return
    }

    fetch('/admin/api/auth/providers')
      .then(r => r.json())
      .then(data => {
        setLoginConfig(data)
        if (data.autoLogin) {
          navigate('/admin/dashboard', { replace: true })
        }
      })
      .catch(() => setLoginConfig({ loginView: 'oauth', providers: [] }))
      .finally(() => setLoading(false))
  }, [])

  async function finishLogin(sessionToken) {
    try {
      const res = await fetch('/admin/api/auth/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionToken }),
      })
      if (!res.ok) throw new Error('Login failed')
      navigate('/admin/dashboard', { replace: true })
    } catch (err) {
      setError(err.message)
      setLoading(false)
    }
  }

  async function handleLogin(providerId) {
    setLoggingIn(true)
    try {
      const res = await fetch('/admin/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId }),
      })
      const data = await res.json()
      if (data.redirect) {
        window.location.href = data.redirect
      } else {
        throw new Error('No redirect URL received')
      }
    } catch (err) {
      setError(err.message)
      setLoggingIn(false)
    }
  }

  const providers = loginConfig?.providers || []
  const loginView = loginConfig?.loginView || 'oauth'

  if (loading || loggingIn) {
    return (
      <div className="login-page">
        <div className="login-card">
          <h1>Relio</h1>
          <p>LLM Relay Dashboard</p>
          <p>{loggingIn ? 'Redirecting to provider...' : 'Loading...'}</p>
        </div>
      </div>
    )
  }

  if (loginView === 'none') {
    return null
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>Relio</h1>
        <p>LLM Relay Dashboard</p>
        {error && <div className="alert alert-error">{error}</div>}
        {providers.length === 0 ? (
          <p>No authentication providers available.</p>
        ) : (
          <div className="providers-list">
            {providers.map(p => (
              <button
                key={p.id}
                className="btn provider-btn"
                onClick={() => handleLogin(p.id)}
              >
                {p.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
