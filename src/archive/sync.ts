/**
 * 惰性刷新队列。
 *
 * 策略参考原项目目录队列：消息驱动、同群合并、有界容量和失败退避。
 *
 * ## 三条核心设计
 *
 * 1. **消息驱动，不做定时全量扫。** 没有消息就完全不打扰设备。
 *    设备通道是单条 WebSocket，查询命令和「回复消息」抢同一个通道，
 *    乱查会拖慢回复。
 * 2. **绝不阻塞消息接收。** 入队是同步的（只往 Map 里塞一条），
 *    真正的设备查询在后台任务里跑。
 * 3. **有界 + 合并 + 退避。** 队列上限 512；同一个群短时间内多次触发合并成一次；
 *    失败按 5/30/120 秒重试，耗尽后冷却 5 分钟。
 */

import type { Context } from '@koishijs/core'

/** 队列与节流参数。默认值 = 原项目目录刷新队列。 */
export interface SyncOptions {
  /** 队列最多容纳多少个群。 */
  capacity: number
  /** 突发事件先等这么久，把同一波合并成一次查询。 */
  debounceMs: number
  /** **两次设备查询之间至少间隔这么久**（设备通道是串行的）。 */
  intervalMs: number
  /** 同一个群成功查询后的冷却时间。 */
  groupIntervalMs: number
  /** 成员快照超过这么久就认为过期，下次收到消息时刷新。 */
  staleAfterMs: number
  /** 失败重试的等待序列，耗尽后进入冷却。 */
  retryDelaysMs: number[]
}

export const DEFAULT_SYNC_OPTIONS: SyncOptions = {
  capacity: 512,
  debounceMs: 1000,
  intervalMs: 1000,
  groupIntervalMs: 60_000,
  staleAfterMs: 6 * 60 * 60 * 1000,
  retryDelaysMs: [5_000, 30_000, 120_000],
}

/** 一个待刷新的任务。 */
interface Job {
  groupId: string
  /** 最早可以开始的时间（单调时钟，毫秒）。 */
  dueAt: number
  /** 是否因为成员事件而强制刷新（强制刷新不受 stale 判定和冷却限制）。 */
  force: boolean
  /** 查询期间又来了新变动 → 加一，跑完要再来一次。 */
  revision: number
  attempts: number
}

/** 触发刷新的原因，只用于日志。 */
export type RefreshReason = 'message' | 'member-event' | 'missing-actor' | 'stale' | 'manual'

/**
 * 惰性刷新队列。
 *
 * 用法：调用方在收到消息 / 成员事件时调 \`offer()\`，队列自己决定要不要真的去查设备。
 */
export class DirectoryRefresh {
  private readonly pending = new Map<string, Job>()
  private readonly seen = new Set<string>()
  private readonly seenOrder: string[] = []
  private readonly nextAllowed = new Map<string, number>()
  private timer?: NodeJS.Timeout
  private active?: Promise<void>
  private running = false
  private stopped = false

  /** 统计，给控制台 / 状态页看。 */
  completed = 0
  failed = 0
  rejected = 0

  /** 真正的设备查询动作，由插件注入（避免这个类依赖 bot）。 */
  private readonly execute: (groupId: string, force: boolean) => Promise<void>
  /** 查某群是否「资料已齐全」——用于 stale 判定。 */
  private readonly needsRefresh: (groupId: string, options: SyncOptions, actorId?: string) => Promise<boolean>

  constructor(
    private readonly ctx: Context,
    private readonly options: SyncOptions,
    execute: (groupId: string, force: boolean) => Promise<void>,
    needsRefresh: (groupId: string, options: SyncOptions, actorId?: string) => Promise<boolean>,
  ) {
    this.execute = execute
    this.needsRefresh = needsRefresh
  }

  get size(): number {
    return this.pending.size
  }

  /**
   * 收到一条群消息 / 成员事件：判断要不要排一次刷新。
   *
   * 只检查数据库并安排队列，不在消息接收路径等待设备查询。
   */
  async offer(groupId: string, reason: RefreshReason, messageKey?: string, actorId?: string): Promise<void> {
    if (this.stopped) return
    if (!groupId.endsWith('@chatroom')) return

    // 同一条消息重复触发要挡掉（设备会补发），用容量有界的 LRU
    if (messageKey) {
      if (this.seen.has(messageKey)) return
      this.seen.add(messageKey)
      this.seenOrder.push(messageKey)
      while (this.seenOrder.length > 4096) {
        this.seen.delete(this.seenOrder.shift()!)
      }
    }

    const force = reason === 'member-event' || reason === 'manual'
    if (!force) {
      // 没到 stale、也不缺资料 → 不打扰设备
      const needed = await this.needsRefresh(groupId, this.options, actorId).catch(() => true)
      if (!needed) return
    }
    if (this.stopped) return

    const current = this.pending.get(groupId)
    if (current) {
      // 已经在队列里：只是把 revision 加一，让跑完后再来一次
      if (force) {
        current.force = true
        current.revision += 1
      }
      return
    }

    if (this.pending.size >= this.options.capacity) {
      this.rejected += 1
      this.ctx.logger('wechat-archive').warn('目录刷新队列已满（%d），丢弃 %s', this.options.capacity, groupId)
      return
    }

    const now = Date.now()
    this.pending.set(groupId, {
      groupId,
      dueAt: Math.max(now + this.options.debounceMs, this.nextAllowed.get(groupId) ?? 0),
      force,
      revision: 0,
      attempts: 0,
    })
    this.schedule()
  }

  /** 停掉队列（插件卸载时调）。 */
  stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.pending.clear()
    this.seen.clear()
    this.seenOrder.length = 0
    this.nextAllowed.clear()
    return this.active ?? Promise.resolve()
  }

  /** 排下一次执行。这里只定一个定时器，不递归。 */
  private schedule(delay = 0): void {
    if (this.timer || this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      const active = this.tick()
      this.active = active
      void active.finally(() => { if (this.active === active) this.active = undefined })
    }, Math.max(0, delay))
    // 不要因为这个定时器把进程钉住
    this.timer.unref?.()
  }

  /** 取最早到期的任务跑一次，跑完再排下一轮。 */
  private async tick(): Promise<void> {
    if (this.stopped || this.running) return
    const now = Date.now()
    let best: Job | undefined
    for (const job of this.pending.values()) {
      if (!best || job.dueAt < best.dueAt) best = job
    }
    if (!best) return
    if (best.dueAt > now) {
      this.schedule(best.dueAt - now)
      return
    }

    this.running = true
    const revision = best.revision
    const force = best.force
    try {
      await this.execute(best.groupId, force)
      this.completed += 1
      // 成功 → 该群进入冷却
      this.nextAllowed.set(best.groupId, Date.now() + this.options.groupIntervalMs)
      if (best.revision !== revision) {
        // 查询期间又来了新变动：保留下一次
        best.dueAt = Date.now() + Math.max(this.options.debounceMs, this.options.groupIntervalMs)
        best.attempts = 0
        best.force = false
      } else {
        this.pending.delete(best.groupId)
      }
    } catch (error: any) {
      if (this.stopped) return
      this.failed += 1
      this.ctx
        .logger('wechat-archive')
        .warn('目录刷新失败 group=%s: %s', best.groupId, error?.message ?? error)
      if (best.attempts < this.options.retryDelaysMs.length) {
        best.dueAt = Date.now() + this.options.retryDelaysMs[best.attempts]
        best.attempts += 1
      } else {
        // 重试耗尽 → 丢掉任务并冷却，别让它永远占着队列
        this.pending.delete(best.groupId)
        this.nextAllowed.set(best.groupId, Date.now() + Math.max(300_000, this.options.groupIntervalMs))
      }
    } finally {
      this.running = false
    }

    // 两次设备查询之间至少间隔 intervalMs —— 通道是串行的
    if (this.pending.size) this.schedule(this.options.intervalMs)
  }
}
