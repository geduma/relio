import { config } from '../config.js'

const PROVIDER_CACHE = new Map()

/**
 * Load and instantiate the configured auth provider.
 *
 * The provider is determined by `AUTH_PROVIDER` env var, defaulting to 'geduma'.
 * It dynamically imports the module from `src/auth/{type}.js`.
 *
 * To add a custom provider:
 *   1. Create `src/auth/yourprovider.js` exporting a class extending AuthProvider.
 *   2. Set `AUTH_PROVIDER=yourprovider` in `.env`.
 *   3. The factory will load it automatically.
 */
export async function getAuthProvider() {
  const type = config.auth.provider
  if (PROVIDER_CACHE.has(type)) {
    return PROVIDER_CACHE.get(type)
  }

  let mod
  try {
    mod = await import(`./${type}.js`)
  } catch {
    throw new Error(
      `Auth provider "${type}" not found. ` +
      `Create src/auth/${type}.js or set AUTH_PROVIDER to one of: geduma, none`
    )
  }

  const Provider = mod.default
  const instance = new Provider()
  PROVIDER_CACHE.set(type, instance)
  return instance
}

export function clearProviderCache() {
  PROVIDER_CACHE.clear()
}
