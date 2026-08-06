/**
 * Temp smoke test: verify the eval wikipedia availability gate passes quickly
 * when wikipedia is healthy (200). Removed after verification.
 */
import { waitForWikipediaAvailable } from '../eval/runner'

const t0 = Date.now()
await waitForWikipediaAvailable(30_000, 5_000)
console.log('gate passed in', Date.now() - t0, 'ms (wikipedia is 200, should be instant)')
