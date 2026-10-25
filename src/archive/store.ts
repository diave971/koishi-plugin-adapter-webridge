import type { Context, Session, Bot } from '@koishijs/core'
import type { Config } from './index.js'
import { defineArchiveModels, type Scope, type GroupRow, type MemberRow } from './schema.js'
import { messageRow, eventRow, rawOf, scopeOf, object, string, occurredAt } from './normalize.js'
import { DirectoryRefresh, DEFAULT_SYNC_OPTIONS } from './sync.js'

declare module '@koishijs/core' {
  interface Events { 'webridge/archive-event'(session: Session): void }
}

const scopeKey = (scope: Scope) => JSON.stringify([scope.platform, scope.accountId])
const date = (value: Date | null | undefined) => value?.valueOf() ?? 0

export class ArchiveService {
  private readonly scopeCtx: Context
  private tail: Promise<unknown> = Promise.resolve()
  private pending = 0
  private written = 0
  private failed = 0
  private dropped = 0
  private stopped = false
  private refreshers = new Map<string, DirectoryRefresh>()
  private mutations = new Map<string, Promise<unknown>>()
  private targets = new Map<string, Session>()
  private guildLists = new Map<string, { at: number; data: Map<string, any> }>()
  private cleanupCursors = new Map<string, string>()

  constructor(private readonly ctx: Context, public config: Config) {
    this.scopeCtx = ctx
    defineArchiveModels(ctx)
    ctx.on('webridge/archive-event', session => {
      if (!ctx.filter(session) || !scopeOf(session)) return
      const received = new Date()
      void this.enqueue(() => this.record(session, received)).catch(() => {})
      if (config.autoRefresh && session.guildId) this.offerRefresh(session)
    })
    ctx.on('ready', () => {
      for (const bot of ctx.bots) {
        if (bot.platform === 'webridge' && !(bot as any).archiveEventsVersion) {
          ctx.logger('wechat-archive').error('当前 WeBridge 适配器缺少归档事件，请更新适配器；该账号无法记录聊天。')
        }
      }
    })
    if (config.retentionDays) {
      const cleanup = () => { void this.enqueue(() => this.cleanup()).catch(() => {}) }
      ctx.on('ready', cleanup)
      ctx.setInterval(cleanup, 3600000)
    }
    ctx.on('dispose', async () => {
      this.stopped = true
      // 查询结束前保留依赖服务，避免后台任务在卸载后继续访问数据库或日志。
      await Promise.all([...this.refreshers.values()].map(refresh => refresh.stop()))
      await this.flush()
      await Promise.allSettled([...this.mutations.values()])
      this.targets.clear()
    })
  }

  status() {
    return { pending: this.pending, written: this.written, failed: this.failed, dropped: this.dropped,
      refreshPending: [...this.refreshers.values()].reduce((sum, q) => sum + q.size, 0),
      refreshFailed: [...this.refreshers.values()].reduce((sum, q) => sum + q.failed, 0),
      refreshRejected: [...this.refreshers.values()].reduce((sum, q) => sum + q.rejected, 0) }
  }

  async flush() { await this.tail }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.stopped || this.pending >= this.config.writeCapacity) {
      this.dropped++
      this.ctx.logger('wechat-archive').error('归档写入队列不可用，累计丢弃 %d 个任务。', this.dropped)
      return Promise.reject(new Error('archive queue unavailable'))
    }
    this.pending++
    const result = this.tail.then(async () => {
      for (let attempt = 0; ; attempt++) {
        try { const result = await task(); this.written++; return result }
        catch (error) {
          if (attempt >= 2) {
            this.failed++
            this.ctx.logger('wechat-archive').error('归档任务重试后仍失败，累计失败 %d 个任务；未输出消息正文。', this.failed)
            throw error
          }
          await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)))
        }
      }
    }).finally(() => { this.pending-- })
    this.tail = result.catch(() => {})
    return result
  }

  private access(session: Session): Scope {
    const scope = scopeOf(session)
    if (!scope || !this.scopeCtx.filter(session)) throw new Error('会话不在归档范围内')
    return scope
  }

  // 同群快照与增量事件串行合并；设备查询留在锁外，避免阻塞消息落库。
  private async mutate<T>(scope: Scope, task: () => Promise<T>): Promise<T> {
    const key = JSON.stringify(scope)
    const previous = this.mutations.get(key) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(task)
    this.mutations.set(key, result)
    try { return await result }
    finally { if (this.mutations.get(key) === result) this.mutations.delete(key) }
  }

  private async insertOnce(table: 'wechat.archive.message' | 'wechat.archive.event', row: any) {
    // 唯一键负责重启/多实例去重；失败后核对，兼容提交成功但回执丢失。
    if ((await this.ctx.database.get(table, { id: row.id })).length) return
    try { await this.ctx.database.create(table, row) }
    catch (error) { if (!(await this.ctx.database.get(table, { id: row.id })).length) throw error }
  }

  private async record(session: Session, receivedAt: Date) {
    const scope = scopeOf(session)!, raw = rawOf(session)
    const message = messageRow(session, this.config.maxContentLength, receivedAt)
    const event = eventRow(session, receivedAt)
    if (!message && !event) return
    await this.mutate(scope, async () => {
      if (message) await this.insertOnce('wechat.archive.message', message)
      if (event) await this.insertOnce('wechat.archive.event', event)
      const at = occurredAt(raw, receivedAt)
      if (session.guildId) {
        const [old] = await this.ctx.database.get('wechat.archive.group', scope)
        if (!old || raw.room_name || typeof raw.room_remark === 'string') await this.saveGroup(scope, {
          name: string(raw.room_name), ...(typeof raw.room_remark === 'string' ? { remark: string(raw.room_remark) } : {}), updatedAt: at,
        })
      }
      const userId = string(event?.userId || message?.senderId)
      if (userId) {
        const patch: Partial<MemberRow> = { updatedAt: at }
        if (message) {
          // 消息只补空缺资料，不把设备显示名误当作群名片或昵称更新事件。
          const [old] = await this.ctx.database.get('wechat.archive.member', { ...scope, userId })
          if (old) return
          if (message.senderName && message.senderName !== userId) patch.nickname = message.senderName
        }
        if (event) {
          if (raw.member_nick_name) patch.nickname = string(raw.member_nick_name)
          // 入退群事件顶层 room_nick_name 属于群对象，成员昵称只采信明确的改名事件。
          if (event.type === 'group_member_nickname_change' && typeof raw.new_room_nick_name === 'string') {
            patch.roomNickname = string(raw.new_room_nick_name)
          }
          if (event.type === 'group_member_join') Object.assign(patch, {
            membership: 'ACTIVE', membershipAt: at, joinedAt: at, leftAt: null,
          })
          if (event.type === 'group_member_leave') Object.assign(patch, {
            membership: 'LEFT', membershipAt: at, leftAt: at,
          })
        }
        await this.saveMember(scope, userId, patch)
      }
    })
  }

  private async saveGroup(scope: Scope, patch: Partial<GroupRow>) {
    const [old] = await this.ctx.database.get('wechat.archive.group', scope)
    const now = patch.updatedAt ?? new Date()
    const row: GroupRow = old ?? { ...scope, name: '', remark: '', avatarUrl: '', ownerId: '', memberCount: null,
      discoveredAt: now, updatedAt: now, syncedAt: null }
    if (date(row.updatedAt) <= date(now)) {
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined && (value !== '' || key === 'remark')) (row as any)[key] = value
      }
    }
    await this.ctx.database.upsert('wechat.archive.group', [row])
  }

  private async saveMember(scope: Scope, userId: string, patch: Partial<MemberRow>) {
    const [old] = await this.ctx.database.get('wechat.archive.member', { ...scope, userId })
    const row: MemberRow = old ?? { ...scope, userId, nickname: '', roomNickname: '', remark: '', avatarUrl: '',
      isOwner: null, isAdmin: null, membership: '', membershipAt: null, joinedAt: null, leftAt: null,
      updatedAt: patch.updatedAt ?? new Date(), syncedAt: null }
    if (date(row.updatedAt) <= date(patch.updatedAt)) {
      for (const key of ['nickname', 'roomNickname', 'remark', 'avatarUrl', 'isOwner', 'isAdmin', 'updatedAt', 'syncedAt'] as const) {
        if (patch[key] !== undefined) (row as any)[key] = patch[key]
      }
    }
    if (patch.membershipAt && date(patch.membershipAt) >= date(row.membershipAt)) {
      for (const key of ['membership', 'membershipAt', 'joinedAt', 'leftAt'] as const) {
        if (patch[key] !== undefined) (row as any)[key] = patch[key]
      }
    } else if (!row.membership && patch.membership) row.membership = patch.membership
    await this.ctx.database.upsert('wechat.archive.member', [row])
  }

  private offerRefresh(session: Session) {
    const scope = scopeOf(session)!, key = scopeKey(scope)
    const targetKey = JSON.stringify(scope)
    const target = session.bot.session({ type: 'internal', user: session.event.user,
      channel: session.event.channel, guild: session.event.guild })
    target.setInternal('webridge', { accountId: scope.accountId })
    this.targets.delete(targetKey)
    this.targets.set(targetKey, target)
    if (this.targets.size > 4096) this.targets.delete(this.targets.keys().next().value!)
    let queue = this.refreshers.get(key)
    if (!queue) {
      const options = { ...DEFAULT_SYNC_OPTIONS, capacity: this.config.capacity,
        groupIntervalMs: this.config.groupInterval, staleAfterMs: this.config.staleAfter }
      queue = new DirectoryRefresh(this.ctx, options, async (channelId, force) => {
        const target = this.targets.get(JSON.stringify({ ...scope, channelId }))
        if (!target) return
        await this.syncGroup(target, force)
      }, async (channelId, _options, actorId) => {
        const groupScope = { ...scope, channelId }
        const [row] = await this.ctx.database.get('wechat.archive.group', groupScope)
        if (!row?.syncedAt || Date.now() - date(row.syncedAt) >= this.config.staleAfter
          || !row.name || row.name === channelId || !row.ownerId || row.memberCount === null) return true
        if (!actorId) return false
        const [member] = await this.ctx.database.get('wechat.archive.member', { ...groupScope, userId: actorId })
        // 普通消息可能先写入占位成员；没有快照时间仍需补齐目录。
        return !member?.syncedAt
      })
      this.refreshers.set(key, queue)
    }
    const reason = String(rawOf(session).event_name).startsWith('group_member_') || rawOf(session).msg_type === 'system'
      ? 'member-event' : 'message'
    void queue.offer(scope.channelId, reason, undefined, session.userId).catch(() => {})
  }

  async syncGroup(session: Session, force = false) {
    const scope = this.access(session)
    if (!session.guildId || !scope.channelId.endsWith('@chatroom')) throw new Error('仅支持群目录')
    const bot = session.bot as Bot & { deviceAccountId?: string; internal: any }
    if (bot.deviceAccountId !== scope.accountId) throw new Error('设备账号已经变化')
    const started = new Date()
    if (typeof bot.internal?.getGroupSnapshot !== 'function') throw new Error('适配器缺少群快照接口')
    const raw = object(await bot.internal.getGroupSnapshot(scope.channelId, force))
    let summary: any
    try {
      const key = scopeKey(scope)
      let cached = this.guildLists.get(key)
      if (force || !cached || Date.now() - cached.at >= this.config.staleAfter) {
        const list = await bot.getGuildList()
        cached = { at: Date.now(), data: new Map(list.data.map(guild => [guild.id, guild])) }
        this.guildLists.set(key, cached)
      }
      summary = cached.data.get(scope.channelId)
    } catch { /* 头像补充失败不影响成员快照。 */ }
    if (bot.deviceAccountId !== scope.accountId || this.stopped) throw new Error('同步期间设备账号变化或插件停止')
    if ((raw.room_id && raw.room_id !== scope.channelId) || !Array.isArray(raw.members) || raw.members.length > 20000) throw new Error('群快照无效')
    await this.mutate(scope, async () => {
      const patch: Partial<GroupRow> = { updatedAt: started, syncedAt: started }
      if (summary?.avatar) patch.avatarUrl = string(summary.avatar, 4096)
      if (summary?.name) patch.name = string(summary.name)
      if (typeof raw.room_name === 'string' && raw.room_name) patch.name = string(raw.room_name)
      if (typeof raw.room_remark === 'string') patch.remark = string(raw.room_remark)
      const owner = string(raw.owner_user_name || raw.owner_wxid)
      if (owner) patch.ownerId = owner
      if (Number.isInteger(raw.member_count) && raw.member_count >= 0) patch.memberCount = raw.member_count
      await this.saveGroup(scope, patch)
      for (const item of raw.members) {
        const member = object(item), userId = string(member.account_id || member.wxid)
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(userId)) continue
        const memberSession = bot.session({ type: 'internal', channel: session.event.channel,
          guild: session.event.guild, user: { id: userId } })
        if (!this.scopeCtx.filter(memberSession as Session)) continue
        // display_name 可能是本机备注，不能作为 roomNickname。
        const profile: Partial<MemberRow> = { updatedAt: started, syncedAt: started, membership: 'ACTIVE' }
        if (typeof member.nick_name === 'string' && member.nick_name) profile.nickname = string(member.nick_name)
        if (typeof member.room_nick_name === 'string') profile.roomNickname = string(member.room_nick_name)
        if (typeof member.remark === 'string') profile.remark = string(member.remark)
        if (member.avatar_url) profile.avatarUrl = string(member.avatar_url, 4096)
        if (typeof member.is_owner === 'boolean') profile.isOwner = member.is_owner
        else if (owner) profile.isOwner = userId === owner
        if (typeof member.is_admin === 'boolean') profile.isAdmin = member.is_admin
        await this.saveMember(scope, userId, profile)
      }
      // 快照缺席不等于退群；快照出现也不能推翻明确的退群事件。
    })
  }

  async syncAll(session: Session) {
    const origin = this.access(session)
    const bot = session.bot
    const list = await bot.getGuildList()
    if ((bot as any).deviceAccountId !== origin.accountId || this.stopped) throw new Error('设备账号已经变化')
    this.guildLists.set(scopeKey(origin), { at: Date.now(), data: new Map(list.data.map(group => [group.id, group])) })
    let count = 0
    for (const group of list.data) {
      if (!group.id.endsWith('@chatroom')) continue
      const target = bot.session({ type: 'internal', guild: group, channel: { id: group.id, type: 0 }, user: session.event.user })
      target.setInternal('webridge', { accountId: origin.accountId, event_name: 'group_member_sync' })
      if (!this.scopeCtx.filter(target)) continue
      const scope = { ...origin, channelId: group.id }
      await this.mutate(scope, () => this.saveGroup(scope, { name: string(group.name), avatarUrl: string(group.avatar, 4096), updatedAt: new Date() }))
      this.offerRefresh(target)
      count++
    }
    return count
  }

  async group(session: Session) { return (await this.ctx.database.get('wechat.archive.group', this.access(session)))[0] }
  async members(session: Session, includeLeft = false) {
    return this.ctx.database.get('wechat.archive.member', { ...this.access(session),
      ...(includeLeft ? {} : { membership: { $ne: 'LEFT' } }) })
  }
  async member(session: Session, userId: string) {
    return (await this.ctx.database.get('wechat.archive.member', { ...this.access(session), userId }))[0]
  }
  async messages(session: Session, limit = 50, before?: { occurredAt: Date; id: string }) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('查询条数应在 1 至 200 之间')
    return this.ctx.database.get('wechat.archive.message', {
      ...this.access(session), ...(before ? { $or: [
        { occurredAt: { $lt: before.occurredAt } }, { occurredAt: before.occurredAt, id: { $lt: before.id } },
      ] } : {}),
    }, { sort: { occurredAt: 'desc', id: 'desc' }, limit })
  }

  async events(session: Session, limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('查询条数应在 1 至 200 之间')
    return this.ctx.database.get('wechat.archive.event', this.access(session), { sort: { occurredAt: 'desc', id: 'desc' }, limit })
  }

  private async cleanup() {
    if (!this.config.retentionDays) return
    const cutoff = new Date(Date.now() - this.config.retentionDays * 86400000)
    for (const table of ['wechat.archive.message', 'wechat.archive.event'] as const) {
      let after = this.cleanupCursors.get(table) ?? ''
      // 每小时每表最多处理 5000 条，避免清理任务长时间占住写入队列。
      for (let page = 0; page < 10; page++) {
        const rows = await this.ctx.database.get(table, { receivedAt: { $lt: cutoff }, id: { $gt: after } },
          { sort: { id: 'asc' }, limit: 500 })
        if (!rows.length) { this.cleanupCursors.set(table, ''); break }
        after = rows.at(-1)!.id
        this.cleanupCursors.set(table, after)
        const ids: string[] = []
        for (const row of rows) {
          const bot = this.ctx.bots.find(bot => bot.platform === row.platform && (bot as any).deviceAccountId === row.accountId)
          if (!bot) continue
          const group = row.channelId.endsWith('@chatroom')
          const session = bot.session({ type: 'internal', channel: { id: row.channelId, type: group ? 0 : 1 },
            guild: group ? { id: row.channelId } : undefined,
            user: { id: (row as any).senderId || (row as any).userId } })
          if (this.scopeCtx.filter(session)) ids.push(row.id)
        }
        if (ids.length) await this.ctx.database.remove(table, { id: { $in: ids } })
      }
    }
  }
}
