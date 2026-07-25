import { Router } from 'express'
import { login, logout, getLoginConfig, getLoginView, autoLogin } from '../services/authService.js'

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
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === 'true',
    sameSite: process.env.COOKIE_SAME_SITE || 'strict',
    maxAge: 24 * 60 * 60 * 1000,
  })
}

router.get('/callback', async (req, res) => {
  try {
    const { provider, code } = req.query
    if (!provider || !code) {
      return res.status(400).send('Missing provider or code parameter')
    }

    const result = await login({ provider, code })
    setSessionCookie(res, result.sessionId)
    res.redirect('/admin/dashboard')
  } catch (err) {
    res.redirect(`/admin/login?error=${encodeURIComponent('Authentication failed')}`)
  }
})

router.post('/login', async (req, res) => {
  try {
    const result = await login(req.body)
    setSessionCookie(res, result.sessionId)
    res.json({ user: result.user })
  } catch (err) {
    res.status(401).json({ error: 'Login failed', message: err.message })
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
