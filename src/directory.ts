import type { Session } from '@satorijs/core'
import type { ContactSummary, EventFrame, RoomMembersResult } from './types.js'
import { contactToGuildMember, roomToGuild } from './contacts.js'
import { createTimeToSeconds, groupMemberId, groupMemberRoomId } from './protocol.js'

interface Entry {
  snapshot?: RoomMembersResult
  expires: number
  retryAt: number
  revision: number
  eventAt: Map<string, number>
  missingRetryAt: number
  pending?: Promise<RoomMembersResult>
}

/** 每个机器人独享的有界通讯录；不依赖数据库，也不保存聊天内容。 */
export class WebridgeDirectory {
  private entries = new Map<string, Entry>()
  private generation = 0
  constructor(
    private readonly query: (guildId: string) => Promise<RoomMembersResult>,
    private readonly account: () => string | undefined,
    private readonly ttl = 300000,
    private readonly capacity = 256,
    private readonly savedNicknames?: (guildId: string, userId?: string) => Promise<ReadonlyMap<string, string>>,
  ) {}

  clear() { this.generation++; this.entries.clear() }

  private entry(guildId: string): Entry {
    if (!guildId.endsWith('@chatroom')) throw new Error('需要有效的群 ID')
    let entry = this.entries.get(guildId)
    if (entry) { this.entries.delete(guildId); this.entries.set(guildId, entry); return entry }
    if (this.entries.size >= this.capacity) {
      const oldest = [...this.entries].find(([, value]) => !value.pending)
      if (!oldest) throw new Error('通讯录查询队列已满')
      this.entries.delete(oldest[0])
    }
    entry = { expires: 0, retryAt: 0, revision: 0, eventAt: new Map(), missingRetryAt: 0 }
    this.entries.set(guildId, entry)
    return entry
  }

  async snapshot(guildId: string, force = false): Promise<RoomMembersResult> {
    const entry = this.entry(guildId)
    if (!force && entry.snapshot && entry.expires > Date.now()) return entry.snapshot
    if (entry.pending) return entry.pending
    if (!force && entry.retryAt > Date.now()) {
      if (entry.snapshot) return entry.snapshot
      throw new Error('通讯录查询暂不可用')
    }
    const generation = this.generation, account = this.account(), revision = entry.revision
    if (!account) throw new Error('设备尚未登录')
    const pending = Promise.resolve().then(() => this.query(guildId)).then(raw => {
      if (generation !== this.generation || account !== this.account()) throw new Error('通讯录查询期间设备账号或连接变化')
      if (revision !== entry.revision) throw new Error('通讯录查询期间成员资料发生变化')
      if (!raw || raw.room_id !== guildId || !Array.isArray(raw.members) || raw.members.length > 20000) throw new Error('群快照无效')
      entry.snapshot = { ...raw, members: raw.members.filter(member => typeof member?.account_id === 'string' && member.account_id) }
      entry.expires = Date.now() + this.ttl
      entry.retryAt = 0
      return entry.snapshot
    }).catch(error => { if (revision === entry.revision) entry.retryAt = Date.now() + 10000; throw error })
      .finally(() => { if (entry.pending === pending) entry.pending = undefined })
    entry.pending = pending
    return pending
  }

  async member(guildId: string, userId: string) {
    const existing = this.entries.get(guildId)?.snapshot
    let raw = await this.snapshot(guildId)
    const entry = this.entry(guildId)
    if (existing === raw && !raw.members.some(member => member.account_id === userId) && entry.missingRetryAt <= Date.now()) {
      entry.missingRetryAt = Date.now() + 10000
      entry.expires = 0
      raw = await this.snapshot(guildId)
    }
    const found = raw.members.find(member => member.account_id === userId)
    return found && (await this.complete([found], guildId, userId))[0]
  }

  async members(guildId: string) {
    return this.complete((await this.snapshot(guildId)).members, guildId)
  }

  /** 设备未提供群名片字段时，保留已归档的最后已知值；空串是明确清空，不回退。 */
  private async complete(members: ContactSummary[], guildId: string, userId?: string, timeout = 1000) {
    if (!this.savedNicknames || timeout <= 0 || members.every(member => typeof member.room_nick_name === 'string')) return members
    const generation = this.generation, account = this.account()
    let timer: ReturnType<typeof setTimeout> | undefined, saved: ReadonlyMap<string, string> | undefined
    try {
      saved = await Promise.race([
        this.savedNicknames(guildId, userId),
        new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeout) }),
      ])
    } catch { /* 归档停用、超时或过滤器不允许查询时，仍可使用设备通讯录。 */ }
    finally { clearTimeout(timer) }
    if (generation !== this.generation || account !== this.account()) throw new Error('读取持久目录期间设备账号或连接变化')
    if (!saved) return members
    return members.map(member => typeof member.room_nick_name === 'string' || !saved.has(member.account_id)
      ? member : { ...member, room_nick_name: saved.get(member.account_id) })
  }

  observe(frame: EventFrame) {
    const guildId = groupMemberRoomId(frame), userId = groupMemberId(frame)
    if (!guildId || !userId) return
    let entry: Entry
    try { entry = this.entry(guildId) } catch { return }
    const at = createTimeToSeconds(frame.body?.create_time) * 1000 || Date.now()
    if (at < (entry.eventAt.get(userId) ?? 0)) return
    entry.eventAt.delete(userId)
    entry.eventAt.set(userId, at)
    if (entry.eventAt.size > 20000) entry.eventAt.delete(entry.eventAt.keys().next().value!)
    entry.revision++
    entry.expires = 0
    entry.retryAt = 0
    const members = entry.snapshot?.members
    if (!members) return
    if (frame.event_name === 'group_member_leave') {
      entry.snapshot!.members = members.filter(member => member.account_id !== userId)
      return
    }
    let member = members.find(member => member.account_id === userId)
    if (!member) { member = { account_id: userId } as ContactSummary; members.push(member) }
    if (typeof frame.body.member_nick_name === 'string') member.nick_name = frame.body.member_nick_name
    // 入退群事件的 room_nick_name 属于群对象，只有明确改名事件能更新成员群昵称。
    if (frame.event_name === 'group_member_nickname_change' && typeof frame.body.new_room_nick_name === 'string') {
      member.room_nick_name = frame.body.new_room_nick_name
    }
  }

  /** 首次缺资料最多等待指定时间；过期缓存先使用，同时后台刷新。 */
  async enrich(session: Session, timeout: number) {
    if (!session.guildId) return
    const generation = this.generation, account = this.account(), started = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const entry = this.entry(session.guildId)
      let raw = entry.snapshot
      if (raw && !raw.members.some(member => member.account_id === session.userId) && entry.missingRetryAt <= Date.now()) {
        entry.missingRetryAt = Date.now() + 10000
        entry.expires = 0
        raw = undefined
      }
      if (raw) {
        if (entry.expires <= Date.now()) void this.snapshot(session.guildId).catch(() => {})
      } else {
        raw = await Promise.race([
          this.snapshot(session.guildId),
          new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeout) }),
        ])
      }
      if (!raw || generation !== this.generation || account !== this.account()) return
      const guild = roomToGuild(raw, session.guildId)
      session.event.guild = { ...session.event.guild, ...guild }
      session.event.channel = { ...session.event.channel!, name: guild.name }
      const contact = raw.members.find(member => member.account_id === session.userId)
      if (!contact) return
      const [completed] = await this.complete([contact], session.guildId, session.userId, Math.max(0, timeout - (Date.now() - started)))
      if (generation !== this.generation || account !== this.account()) return
      const member = contactToGuildMember(completed)
      session.event.user = member.user
      const { user: _user, ...profile } = member
      session.event.member = profile
    } catch { /* 查询失败仍派发消息，后续消息可以重新补齐资料。 */ }
    finally { clearTimeout(timer) }
  }
}
