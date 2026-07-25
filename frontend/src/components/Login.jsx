import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

export default function Login() {
  const [loginConfig, setLoginConfig] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  useEffect(() => {
    const urlError = searchParams.get('error')
    if (urlError) setError(urlError)

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

  function handleLogin(oauthUrl) {
    window.location.href = oauthUrl
  }

  const providers = loginConfig?.providers || []
  const loginView = loginConfig?.loginView || 'oauth'

  if (loading) {
    return (
      <div className="login-page">
        <div className="login-card">
          <h1>Relio</h1>
          <p>LLM Relay Dashboard</p>
          <p>Loading...</p>
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
                onClick={() => handleLogin(p.oauth_url)}
              >
                {p.icon && <img src={p.icon} alt="" className="provider-icon" />}
                {p.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
