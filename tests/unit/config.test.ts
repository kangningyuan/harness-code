import { resolveConfig } from '../../src/cli/config.js'

describe('resolveConfig', () => {
  const clean = () => {
    for (const key of ['HARNESS_API_KEY','HARNESS_AUTH_TOKEN','HARNESS_BASE_URL','HARNESS_MODEL','HARNESS_SMALL_MODEL','HARNESS_MAX_OUTPUT_TOKENS','ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL']) delete process.env[key]
  }
  beforeEach(clean)
  afterEach(clean)
  it('uses documented defaults', () => {
    expect(resolveConfig({}, { env: {} })).toMatchObject({ baseURL: '', model: 'gpt-5.5', smallModel: 'gpt-5.4-mini', maxOutputTokens: 8192, timeoutMs: 600000 })
  })
  it('applies CLI > env > file > settings', () => {
    const settings = { apiKey: 'settings', baseURL: 'https://settings/', model: 'settings-model' }
    const configFile = { apiKey: 'file', baseURL: 'https://file/', model: 'file-model', smallModel: 'file-small', maxOutputTokens: 100 }
    const env = { HARNESS_API_KEY: 'env', HARNESS_BASE_URL: 'https://env/', HARNESS_MODEL: 'env-model', HARNESS_SMALL_MODEL: 'env-small', HARNESS_MAX_OUTPUT_TOKENS: '200' }
    expect(resolveConfig({ apiKey: 'cli', model: 'cli-model' }, { env, configFile, settings })).toMatchObject({ apiKey: 'cli', baseURL: 'https://env', model: 'cli-model', smallModel: 'env-small', maxOutputTokens: 200 })
  })
  it('does not read ANTHROPIC variables', () => {
    expect(resolveConfig({}, { env: { ANTHROPIC_API_KEY: 'bad', ANTHROPIC_BASE_URL: 'https://bad' } })).toMatchObject({ apiKey: undefined, baseURL: '' })
  })
  it('supports auth token and strips trailing slashes', () => {
    expect(resolveConfig({}, { env: { HARNESS_AUTH_TOKEN: 'token', HARNESS_BASE_URL: 'https://x///', API_TIMEOUT_MS: '42' } })).toMatchObject({ apiKey: 'token', baseURL: 'https://x', timeoutMs: 42 })
  })
})
