import { Router } from 'express'
import { config } from '../config.js'
import { getProviders, login as gedumaLogin } from '../external/gedumaClient.js'
import { loginWithGeduma, logout } from '../services/authService.js'

const router = Router()

router.get('/providers', async (req, res) => {
  try {
    const data = await getProviders()
    const providers = (data.providers || []).map(p => ({
      ...p,
      oauth_url: `${config.geduma.apiUrl}/oauth/${p.id}?redirect=${encodeURIComponent(`${config.server.baseUrl}/admin/api/auth/callback?provider=${p.id}`)}`,
    }))
    res.json({ providers })
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch providers', message: err.message })
  }
})

router.get('/callback', async (req, res) => {
  try {
    const { provider, code } = req.query
    if (!provider || !code) {
      return res.status(400).send('Missing provider or code parameter')
    }

    const result = await loginWithGeduma(provider, code)

    res.cookie('relio_session', result.sessionId, {
      httpOnly: true,
      secure: process.env.COOKIE_SECURE === 'true',
      sameSite: process.env.COOKIE_SAME_SITE || 'strict',
      maxAge: 24 * 60 * 60 * 1000,
    })

    res.redirect('/admin/dashboard')
  } catch (err) {
    res.redirect(`/admin/login?error=${encodeURIComponent('Authentication failed')}`)
  }
})

router.post('/login', async (req, res) => {
  try {
    const { provider, code } = req.body
    if (!provider || !code) {
      return res.status(400).json({ error: 'provider and code are required' })
    }

    const result = await loginWithGeduma(provider, code)

    res.cookie('relio_session', result.sessionId, {
      httpOnly: true,
      secure: process.env.COOKIE_SECURE === 'true',
      sameSite: process.env.COOKIE_SAME_SITE || 'strict',
      maxAge: 24 * 60 * 60 * 1000,
    })

    res.json({ user: result.user })
  } catch (err) {
    res.status(401).json({ error: 'Login failed', message: err.message })
  }
})

router.post('/logout', (req, res) => {
  const sessionId = req.cookies?.relio_session
  if (sessionId) {
    logout(sessionId)
  }
  res.clearCookie('relio_session')
  res.json({ success: true })
})

export default router
