import { assertResumeCursor, UnsupportedResumeAdapter, type ResumeAdapter } from '../../src/services/api/resume.js'

describe('resume adapter contract', () => {
  it('rejects unsupported resume attempts rather than replaying blindly', async () => {
    const adapter = new UnsupportedResumeAdapter()
    expect(adapter.supported).toBe(false)
    const resumable: ResumeAdapter = adapter
    await expect(resumable.resume({ requestId: 'r', sequence: 0 }, () => undefined)).rejects.toThrow('does not advertise resumable')
  })

  it.each([
    [{ requestId: '', sequence: 0 }, 'Resume cursor request mismatch'],
    [{ requestId: 'other', sequence: 0 }, 'Resume cursor request mismatch'],
    [{ requestId: 'expected', sequence: -1 }, 'Invalid resume cursor sequence'],
    [{ requestId: 'expected', sequence: 1.5 }, 'Invalid resume cursor sequence'],
    [{ requestId: 'expected', sequence: Number.NaN }, 'Invalid resume cursor sequence'],
  ])('rejects invalid cursor %#', (cursor, error) => {
    expect(() => assertResumeCursor(cursor, 'expected')).toThrow(error)
  })

  it('accepts zero and positive integer cursors for the same request', () => {
    expect(() => assertResumeCursor({ requestId: 'expected', sequence: 0, lastEventId: '0', token: 't' }, 'expected')).not.toThrow()
    expect(() => assertResumeCursor({ requestId: 'expected', sequence: 10 }, 'expected')).not.toThrow()
  })
})
