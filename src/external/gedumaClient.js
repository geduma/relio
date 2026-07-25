import { config } from '../config.js'

const BASE_URL = config.geduma.apiUrl
const TOKEN = config.geduma.apiToken

function authHeaders(extraToken) {
  return {
    'Authorization': `Bearer ${extraToken || TOKEN}`,
    'Content-Type': 'application/json',
  }
}

export async function getProviders() {
  const res = await fetch(`${BASE_URL}/api/auth/providers`, {
    headers: authHeaders(),
  })
  if (!res.ok) {
    throw new Error(`Geduma providers failed: ${res.status}`)
  }
  return res.json()
}

export async function login(provider, code) {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ provider, code }),
  })
  if (!res.ok) {
    throw new Error(`Geduma login failed: ${res.status}`)
  }
  return res.json()
}

export async function getUser(sessionToken) {
  const res = await fetch(`${BASE_URL}/api/auth/user`, {
    headers: authHeaders(sessionToken),
  })
  if (!res.ok) {
    throw new Error(`Geduma user fetch failed: ${res.status}`)
  }
  return res.json()
}
