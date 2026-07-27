import { Router } from 'express'
import { login, logout, initiateLogin, getLoginConfig, getLoginView, autoLogin } from '../services/authService.js'
import { config } from '../config.js'

const router = Router()

router.get('/providers', async (req, res) => {
  try {
    const view = await getLoginView()
    if (view === 'none') {
      const result = await autoLogin()
      setSessionCookie(res, result.sessionId)
      return res.json({ loginView: view, autoLogin: true, user: result.user })
    }

    const data = await getLoginConfig()
    res.json({ loginView: view, ...data })
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch providers', message: err.message })
  }
})

function setSessionCookie(res, sessionId) {
  res.cookie('relio_session', sessionId, {
    httpOnly: config.cookie.httpOnly,
    secure: config.server.nodeEnv === 'production' ? true : config.cookie.secure,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
  })
}

router.post('/login', async (req, res) => {
  try {
    const result = await initiateLogin(req.body)
    res.json(result)
  } catch (err) {
    res.status(401).json({ error: 'Login failed', message: err.message })
  }
})

router.get('/callback', async (req, res) => {
  try {
    const { sessionToken } = req.query
    if (!sessionToken) {
      return res.status(400).send('Missing sessionToken parameter')
    }

    const result = await login({ sessionToken })
    setSessionCookie(res, result.sessionId)
    res.redirect('/admin/dashboard')
  } catch (err) {
    res.redirect(`/admin/login?error=${encodeURIComponent('Authentication failed')}`)
  }
})

router.post('/callback', async (req, res) => {
  try {
    const { sessionToken } = req.body
    if (!sessionToken) {
      return res.status(400).json({ error: 'Missing sessionToken' })
    }

    const result = await login({ sessionToken })
    setSessionCookie(res, result.sessionId)
    res.json({ user: result.user })
  } catch (err) {
    res.status(401).json({ error: 'Authentication failed', message: err.message })
  }
})

router.post('/logout', async (req, res) => {
  const sessionId = req.cookies?.relio_session
  if (sessionId) {
    await logout(sessionId)
  }
  res.clearCookie('relio_session')
  res.json({ success: true })
})

export default router
