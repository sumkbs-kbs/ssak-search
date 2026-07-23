/**
 * ThreadDO — Conversational Thread Durable Object
 *
 * Manages a single chat thread: stores messages, provides context for
 * follow-up questions, and auto-expires after 1 hour of inactivity.
 *
 * Architecture:
 * - One DO instance per thread (identified by UUID → hex string)
 * - Messages stored in DO SQLite (automatic persistence)
 * - Alarm-based TTL expiry (1h inactivity → auto-delete)
 *
 * RPC methods:
 *   getThread()         → ThreadData
 *   appendMessage()     → ThreadData
 *   getContext()        → previous exchanges for search augmentation
 *   touch()             → reset inactivity timer
 *   deleteThread()      → remove all data
 */

import { DurableObject } from 'cloudflare:workers'
import { logger } from './logger'
import type { Env, ThreadData, ThreadMessage } from '../types'

const INACTIVITY_TTL_MS = 60 * 60 * 1000 // 1 hour

interface ThreadStorage {
  messages: ThreadMessage[]
  created_at: number
  last_activity: number
}

export class ThreadDO extends DurableObject<Env> {
  private messages: ThreadMessage[] = []
  private createdAt = 0
  private lastActivity = 0

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)

    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<ThreadStorage>('thread')
      if (stored) {
        this.messages = stored.messages
        this.createdAt = stored.created_at
        this.lastActivity = stored.last_activity
      }

      // Register alarm handler for auto-expiry
      this.ctx.storage.setAlarm(this.lastActivity + INACTIVITY_TTL_MS)
    })
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put<ThreadStorage>('thread', {
      messages: this.messages,
      created_at: this.createdAt,
      last_activity: this.lastActivity,
    })
  }

  /**
   * Get full thread data.
   */
  async getThread(): Promise<ThreadData> {
    return {
      id: this.ctx.id.toString(),
      messages: this.messages,
      created_at: this.createdAt,
      last_activity: this.lastActivity,
      message_count: this.messages.length,
    }
  }

  /**
   * Append a message to the thread.
   */
  async appendMessage(msg: ThreadMessage): Promise<ThreadData> {
    this.messages.push(msg)
    this.lastActivity = Date.now()
    if (this.createdAt === 0) {
      this.createdAt = this.lastActivity
    }

    await this.persist()

    // Reset inactivity alarm
    await this.ctx.storage.setAlarm(this.lastActivity + INACTIVITY_TTL_MS)

    return this.getThread()
  }

  /**
   * Get recent conversation context for search augmentation.
   * Returns the last N exchanges (user + assistant pairs).
   */
  async getContext(exchanges = 3): Promise<Array<{ query: string; answer: string }>> {
    const pairs: Array<{ query: string; answer: string }> = []
    let i = this.messages.length - 1

    while (i >= 0 && pairs.length < exchanges) {
      // Find an assistant message
      if (this.messages[i].role === 'assistant') {
        const answer = this.messages[i].content
        // Find the preceding user message
        const query = i > 0 && this.messages[i - 1].role === 'user'
          ? this.messages[i - 1].content
          : ''
        pairs.unshift({ query, answer })
        i -= 2
      } else {
        i--
      }
    }

    return pairs
  }

  /**
   * Reset inactivity timer (called on every chat request).
   */
  async touch(): Promise<void> {
    this.lastActivity = Date.now()
    await this.persist()
    await this.ctx.storage.setAlarm(this.lastActivity + INACTIVITY_TTL_MS)
  }

  /**
   * Delete all thread data.
   */
  async deleteThread(): Promise<void> {
    this.messages = []
    this.createdAt = 0
    this.lastActivity = 0
    await this.ctx.storage.deleteAll()
    await this.ctx.storage.deleteAlarm()
  }

  /**
   * Alarm handler: auto-delete after inactivity TTL.
   */
  async alarm(): Promise<void> {
    const now = Date.now()
    if (now - this.lastActivity >= INACTIVITY_TTL_MS) {
      logger.info(`[ThreadDO] Expiring thread ${this.ctx.id.toString()} after inactivity`)
      await this.ctx.storage.deleteAll()
    }
  }
}

// ============================================================
// Client-side RPC stubs
// ============================================================

export interface ThreadRPC {
  getThread(): Promise<ThreadData>
  appendMessage(msg: ThreadMessage): Promise<ThreadData>
  getContext(exchanges?: number): Promise<Array<{ query: string; answer: string }>>
  touch(): Promise<void>
  deleteThread(): Promise<void>
}

/**
 * Get a ThreadDO stub by its hex ID.
 */
export function getThreadStub(env: Env, threadId: string): ThreadRPC {
  const id = env.THREAD_DO!.idFromString(threadId)
  return env.THREAD_DO!.get(id) as unknown as ThreadRPC
}

/**
 * Create a new ThreadDO stub with a unique ID.
 */
export function createThreadStub(env: Env): { stub: ThreadRPC; id: string } {
  const doId = env.THREAD_DO!.newUniqueId()
  const stub = env.THREAD_DO!.get(doId) as unknown as ThreadRPC
  return { stub, id: doId.toString() }
}
