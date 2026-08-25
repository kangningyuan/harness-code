import { describe, it } from 'vitest'

export const RUN_API_TESTS = process.env.RUN_API_TESTS === '1' || process.env.RUN_API_TESTS === 'true'
export const TEST_API_KEY = process.env.HARNESS_API_KEY ?? ''
export const TEST_BASE_URL = process.env.HARNESS_BASE_URL ?? ''
export const TEST_MODEL = process.env.HARNESS_MODEL ?? 'gpt-5.5'
const hasCreds = Boolean(TEST_API_KEY && TEST_BASE_URL)
export const itApi = (RUN_API_TESTS && hasCreds) ? it : it.skip
export const describeApi = (RUN_API_TESTS && hasCreds) ? describe : describe.skip
