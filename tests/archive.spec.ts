import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App, Bot, type Context, type Session } from '@koishijs/core'
import sqlite from '@koishijs/plugin-database-sqlite'
import pg from '@koishijs/plugin-database-postgres'
import * as archive from '../src/archive/index.js'
import { WebridgeBot } from '../src/bot.js'

class TestBot extends Bot<Context> {
  static inject = ['satori', 'koishi']
  static reusable = true
  archiveEventsVersion = 1
  deviceAccountId: string
  snapshot: any = { room_id: 'allowed@chatroom', room_name: '群名', room_remark: '备注', owner_user_name: 'alice', member_count: 2,
    members: [{ account_id: 'alice', nick_name: '原昵称', display_name: '本机备注', room_nick_name: '群名片', is_admin: false }, { account_id: 'bob' }, { account_id: 'blocked' }] }
  snapshotCall = async () => this.snapshot
  snapshotCalls = 0
  guildCalls = 0
  constructor(ctx: Context, config: { selfId: string; account: string; platform?: string }) {
    super(ctx, config, config.platform ?? 'webridge')
    this.user = { id: config.selfId }
    this.deviceAccountId = config.account
    this.internal = { getGroupSnapshot: async () => { this.snapshotCalls++; return this.snapshotCall() } }
  }
  async getGuildList() {
    this.guildCalls++
    return { data: [{ id: 'allowed@chatroom', name: '群名', avatar: 'https://example.invalid/avatar.png' }] }
  }
}

async function fixture(config: Partial<archive.Config> = {}, existingDirectory?: string) {
  const directory = existingDirectory ?? await mkdtemp(join(tmpdir(), 'wechat-archive-'))
  const path = join(directory, 'test.db')
  const app = new App()
  const pgConfig = process.env.WECHAT_TEST_POSTGRES_CONFIG && JSON.parse(process.env.WECHAT_TEST_POSTGRES_CONFIG)
  const driver = pgConfig ? pg : sqlite
  app.plugin((driver as any).default ?? driver, pgConfig || { path })
  const scope = app.platform('webridge').channel('allowed@chatroom', 'other@chatroom', 'private').exclude(app.user('blocked'))
  let service!: archive.ArchiveService
  const fork = scope.plugin({ inject: ['database'], apply(ctx: Context) {
    service = archive.installArchive(ctx, archive.Config({ autoRefresh: false, ...config } as archive.Config))
  } })
  app.plugin(TestBot, { selfId: 'configured-a', account: 'wxid_a' })
  app.plugin(TestBot, { selfId: 'configured-b', account: 'wxid_b' })
  await app.start()
  for (const table of ['wechat.archive.message', 'wechat.archive.event', 'wechat.archive.member', 'wechat.archive.group'] as const) {
    await app.database.get(table, {})
    if (!existingDirectory) await app.database.remove(table, {})
  }
  const [bot, second] = app.bots as unknown as TestBot[]
  function session(raw: Record<string, any> = {}, target = bot, channelId = 'allowed@chatroom') {
    const group = channelId.endsWith('@chatroom')
    const s = target.session({ type: 'internal', channel: { id: channelId, type: group ? 0 : 1 },
      guild: group ? { id: channelId } : undefined, user: { id: raw.member_id || raw.sender_id || 'alice', name: '昵称' } })
    s.setInternal('webridge', { accountId: target.deviceAccountId, event_name: 'message', msg_type: 'text',
      create_time: 1792400000, message_id: 'message-1', room_id: group ? channelId : '', chat_id: channelId,
      sender_id: 'alice', content: '正文', ...raw })
    return s
  }
  function emit(s: Session) { app.emit(s as any, 'webridge/archive-event', s) }
  async function close(clean = true) {
    await app.stop()
    if (clean) { await rm(path, { force: true }); await rmdir(directory) }
  }
  return { app, bot, second, service, fork, session, emit, close, directory }
}

test('真实 Koishi 事件：去重、账号/群/私聊隔离、过滤器、正文和引用，以及卸载', async () => {
  const f = await fixture()
  try {
    const s = f.session({ content: '<at id="evil"/> 原文', quote_msg_id: 'quoted' })
    for (let i = 0; i < 12; i++) f.emit(s)
    f.emit(f.session({}, f.second))
    f.emit(f.session({}, f.bot, 'other@chatroom'))
    f.emit(f.session({}, f.bot, 'private'))
    f.emit(f.session({ sender_id: 'blocked' }))
    f.emit(f.session({}, f.bot, 'closed@chatroom'))
    await f.service.flush()
    assert.equal((await f.app.database.get('wechat.archive.message', {})).length, 4)
    const [row] = await f.service.messages(s)
    assert.equal(row.accountId, 'wxid_a')
    assert.equal(row.selfId, 'configured-a')
    assert.equal(row.content, '<at id="evil"/> 原文')
    assert.equal(row.quoteId, 'quoted')
    assert.equal((await f.service.messages(f.session({}, f.second))).length, 1)
    await assert.rejects(f.service.messages(f.session({}, f.bot, 'closed@chatroom')), /范围/)
    await assert.rejects(f.service.messages(s, 201), /条数/)
    await f.fork.dispose()
    f.emit(f.session({ message_id: 'after-dispose' }))
    assert.equal((await f.app.database.get('wechat.archive.message', {})).length, 4)
  } finally { await f.close() }
})

test('群快照、真实成员事件、乱序事件与旧快照，保留退群资料且不伪造入群时间', async () => {
  const f = await fixture()
  try {
    const s = f.session()
    await f.service.syncGroup(s)
    assert.equal((await f.service.group(s))!.remark, '备注')
    assert.equal((await f.service.group(s))!.avatarUrl, 'https://example.invalid/avatar.png')
    const alice = await f.service.member(s, 'alice')
    assert.equal(alice.nickname, '原昵称'); assert.equal(alice.roomNickname, '群名片')
    assert.equal(alice.isOwner, true); assert.equal(alice.isAdmin, false)
    assert.equal(alice.joinedAt, null)
    assert.equal(await f.service.member(s, 'blocked'), undefined)
    const time = Math.ceil(Date.now() / 1000) + 1
    const memberEvent = (type: string, at: number, extra = {}) => f.session({ event_name: type, message_id: '', event_id: `${type}:${at}`,
      member_id: 'alice', create_time: at, ...extra })
    let resolve!: (value: unknown) => void
    f.bot.snapshotCall = () => new Promise(r => { resolve = r })
    const sync = f.service.syncGroup(s)
    await new Promise(r => setImmediate(r))
    f.emit(memberEvent('group_member_leave', time))
    f.emit(memberEvent('group_member_nickname_change', time + 1, { old_room_nick_name: '群名片', new_room_nick_name: '新名片' }))
    await f.service.flush()
    resolve(f.bot.snapshot)
    await sync
    assert.equal((await f.service.member(s, 'alice')).membership, 'LEFT')
    assert.equal((await f.service.member(s, 'alice')).roomNickname, '新名片')
    assert.equal((await f.service.members(s)).some(x => x.userId === 'alice'), false)
    f.emit(memberEvent('group_member_join', time + 3))
    f.emit(memberEvent('group_member_leave', time + 2))
    await f.service.flush()
    const joined = await f.service.member(s, 'alice')
    assert.equal(joined.membership, 'ACTIVE'); assert.equal(joined.leftAt, null)
    assert.equal(joined.joinedAt!.valueOf(), (time + 3) * 1000)
    f.bot.snapshotCall = async () => ({ ...f.bot.snapshot, members: [] })
    await f.service.syncGroup(s)
    assert.equal((await f.service.member(s, 'bob')).membership, 'ACTIVE', '缺席不能推断退群')
    assert.equal((await f.service.events(s)).length, 4)
    assert.equal(f.bot.guildCalls, 1, '群头像列表应缓存')
    f.bot.snapshotCall = async () => { f.bot.deviceAccountId = 'changed'; return f.bot.snapshot }
    await assert.rejects(f.service.syncGroup(s), /账号变化/)
  } finally { await f.close() }
})

test('适配器归档入口覆盖自发消息、过期消息及关闭 acceptMedia 的媒体，不进入业务回复', async () => {
  const f = await fixture()
  try {
    const bot: any = f.bot
    bot.config.acceptMedia = false
    bot.eventTimestamp = (WebridgeBot.prototype as any).eventTimestamp
    bot.dispatchArchiveEvent = (WebridgeBot.prototype as any).dispatchArchiveEvent
    const seen = new Set()
    bot.isDuplicate = (key: string) => { const duplicate = seen.has(key); seen.add(key); return duplicate }
    bot.settleSelfEcho = () => {}
    bot.isStale = () => true
    bot.dispatchGroupMember = () => true
    let dispatched = 0
    bot.dispatch = () => { dispatched++ }
    function frame(id: string, body: object) { return { type: 'event', event_name: 'message', event_id: id,
      captured_at_ms: Date.now(), body: { room_id: 'allowed@chatroom', chat_id: 'allowed@chatroom',
        message_id: id, sender_id: 'alice', create_time: 1, ...body } } }
    const frames = [frame('self', { sender_id: 'wxid_a', msg_type: 'text', content: '自己的消息' }),
      frame('stale', { msg_type: 'text', content: '过期补发' }), frame('image', { msg_type: 'image',
        content: '<msg><img aeskey="secret"/></msg>', image_url: 'https://example.invalid/a?token=secret', image_aeskey: 'secret' })]
    for (const frame of [...frames, frames[0]]) (WebridgeBot.prototype as any).onEvent.call(bot, frame)
    await f.service.flush()
    const rows = await f.service.messages(f.session())
    assert.equal(rows.length, 3); assert.equal(dispatched, 0)
    assert.equal(rows.find(x => x.messageId === 'self')!.direction, 'out')
    const image = rows.find(x => x.type === 'image')!
    assert.equal(JSON.stringify(image).includes('secret'), false)
    assert.match(image.content, /redacted/)
  } finally { await f.close() }
})

test('写入丢回执与短暂故障重试、分页、保留期限及过滤范围', async () => {
  const f = await fixture({ retentionDays: 1, maxContentLength: 1000 })
  try {
    const original = f.app.database.create.bind(f.app.database)
    let calls = 0
    f.app.database.create = (async (table: any, row: any) => {
      if (table === 'wechat.archive.message' && ++calls === 1) throw new Error('暂时断连')
      const value = await original(table, row)
      if (table === 'wechat.archive.message' && calls === 2) throw new Error('提交后断连')
      return value
    }) as any
    for (let i = 0; i < 5; i++) f.emit(f.session({ message_id: `page-${i}`, content: '字'.repeat(1001) }))
    await f.service.flush()
    const s = f.session(), first = await f.service.messages(s, 2)
    const second = await f.service.messages(s, 2, { occurredAt: first.at(-1)!.occurredAt, id: first.at(-1)!.id })
    assert.equal(new Set([...first, ...second].map(x => x.id)).size, 4)
    assert.equal(first[0].truncated, true); assert.equal(first[0].content.length, 1000)
    assert.equal(f.service.status().failed, 0)
    const old = new Date(Date.now() - 3 * 86400000)
    await f.app.database.set('wechat.archive.message', {}, { receivedAt: old })
    const [copy] = await f.service.messages(s)
    await f.app.database.create('wechat.archive.message', { ...copy, id: 'f'.repeat(64), channelId: 'closed@chatroom' })
    await (f.service as any).cleanup()
    assert.equal((await f.service.messages(s)).length, 0)
    assert.equal((await f.app.database.get('wechat.archive.message', {})).length, 1)
    assert.ok(await f.service.group(s))
  } finally { await f.close() }
})

test('自动刷新按群合并且不会阻塞消息写入，卸载后不再查询设备', async () => {
  const f = await fixture({ autoRefresh: true })
  try {
    for (let i = 0; i < 10; i++) f.emit(f.session({ message_id: `burst-${i}` }))
    await f.service.flush()
    assert.equal((await f.service.messages(f.session())).length, 10)
    assert.equal(f.bot.snapshotCalls, 0)
    await new Promise(r => setTimeout(r, 1300))
    assert.equal(f.bot.snapshotCalls, 1)
    await f.fork.dispose()
    f.emit(f.session({ message_id: 'stopped' }))
    await new Promise(r => setTimeout(r, 1100))
    assert.equal(f.bot.snapshotCalls, 1)
  } finally { await f.close() }
})

test('入退群事件中的群名不能污染玩家昵称；快照缺字段、改名与清空均正确处理', async () => {
  const f = await fixture()
  try {
    const s = f.session()
    await f.service.syncGroup(s)
    const join = f.session({ event_name: 'group_member_join', event_id: 'new-player', message_id: '',
      member_id: 'charlie', member_nick_name: '新人昵称', room_nick_name: '测试群', new_room_nick_name: '非改名事件忽略',
      create_time: Date.now() / 1000 })
    f.emit(join)
    await f.service.flush()
    assert.equal((await f.service.member(join, 'charlie')).roomNickname, '')
    f.bot.snapshot.members.push({ account_id: 'charlie', nick_name: '新人昵称' })
    await f.service.syncGroup(join)
    const player = await f.service.member(join, 'charlie')
    assert.ok(player.syncedAt)
    assert.equal(player.roomNickname, '')
    const at = Date.now() / 1000 + 1
    const event = (type: string, index: number, extra = {}) => f.session({ event_name: type,
      event_id: `nickname-${index}`, message_id: '', member_id: 'alice', room_nick_name: '测试群',
      create_time: at + index, ...extra })
    f.emit(event('group_member_leave', 0))
    await f.service.flush()
    assert.equal((await f.service.member(s, 'alice')).roomNickname, '群名片', '退群不能覆盖有效群昵称')
    f.emit(event('group_member_nickname_change', 1, { new_room_nick_name: '测试群' }))
    await f.service.flush()
    assert.equal((await f.service.member(s, 'alice')).roomNickname, '测试群', '明确设置的同名群昵称应保留')
    f.emit(event('group_member_nickname_change', 2, { old_room_nick_name: '测试群', new_room_nick_name: '' }))
    await f.service.flush()
    assert.equal((await f.service.member(s, 'alice')).roomNickname, '')
    const events = await f.service.events(s)
    assert.ok(events.filter(e => e.type !== 'group_member_nickname_change').every(e => e.newName === ''))
    assert.equal(events.find(e => e.eventId === 'nickname-2')!.newName, '', '空串不能回退成群名')
  } finally { await f.close() }
})

test('群快照未过期时，新发言成员及消息占位资料仍会自动补拉目录', async () => {
  const f = await fixture({ autoRefresh: true })
  try {
    await f.service.syncGroup(f.session())
    f.emit(f.session({ message_id: 'known-member' }))
    await f.service.flush()
    await new Promise(r => setTimeout(r, 50))
    assert.equal(f.service.status().refreshPending, 0, '完整且未过期的目录不应逐条刷新')
    f.bot.snapshot.members.push({ account_id: 'charlie', nick_name: '新发言成员' })
    f.emit(f.session({ message_id: 'missing-member', sender_id: 'charlie' }))
    f.emit(f.session({ message_id: 'known-member-after-newcomer' }))
    await f.service.flush()
    assert.equal((await f.service.member(f.session(), 'charlie')).syncedAt, null, '消息先产生占位成员')
    for (let i = 0; i < 100; i++) {
      if ((await f.service.member(f.session(), 'charlie')).syncedAt) break
      await new Promise(r => setTimeout(r, 20))
    }
    assert.equal(f.bot.snapshotCalls, 2)
    assert.equal((await f.service.member(f.session(), 'charlie')).nickname, '新发言成员')
    assert.ok((await f.service.member(f.session(), 'charlie')).syncedAt)
  } finally { await f.close() }
})

test('群名、群主或人数缺失时继续安排刷新；成员事件同时刷新群目录缓存', async () => {
  for (const patch of [{ name: '' }, { ownerId: '' }, { memberCount: null }]) {
    const f = await fixture({ autoRefresh: true })
    try {
      const s = f.session()
      await f.service.syncGroup(s)
      await f.app.database.set('wechat.archive.group', {}, patch)
      f.emit(f.session({ message_id: 'incomplete-group' }))
      await f.service.flush()
      for (let i = 0; i < 50 && !f.service.status().refreshPending; i++) await new Promise(r => setTimeout(r, 10))
      assert.equal(f.service.status().refreshPending, 1, `缺少 ${Object.keys(patch)[0]} 时应补拉`)
    } finally { await f.close() }
  }
  const f = await fixture({ autoRefresh: true })
  try {
    await f.service.syncGroup(f.session())
    f.bot.snapshot.room_name = ''
    f.bot.getGuildList = async () => { f.bot.guildCalls++; return { data: [{ id: 'allowed@chatroom', name: '最新群名', avatar: '新头像' }] } }
    f.emit(f.session({ event_name: 'group_member_join', event_id: 'force-directory', message_id: '', member_id: 'charlie' }))
    for (let i = 0; i < 100; i++) {
      if ((await f.service.group(f.session())).name === '最新群名') break
      await new Promise(r => setTimeout(r, 20))
    }
    assert.equal((await f.service.group(f.session())).name, '最新群名')
    assert.equal(f.bot.guildCalls, 2)
  } finally { await f.close() }
})

test('应用重启后保留记录并继续去重；卸载等待已接收任务落库', async () => {
  let f = await fixture()
  try {
    const directory = f.directory
    f.emit(f.session({ message_id: 'restart' }))
    await f.fork.dispose()
    await f.close(false)
    f = await fixture({}, directory)
    f.emit(f.session({ message_id: 'restart' }))
    await f.service.flush()
    assert.equal((await f.service.messages(f.session())).length, 1)
  } finally { await f.close() }
})

test('卸载等待进行中的目录查询，设备迟到失败不会访问已释放的服务', async () => {
  const f = await fixture({ autoRefresh: true })
  try {
    let reject!: (error: Error) => void
    f.bot.snapshotCall = () => new Promise((_resolve, fail) => { reject = fail })
    f.emit(f.session())
    for (let i = 0; i < 100 && !reject; i++) await new Promise(r => setTimeout(r, 20))
    assert.ok(reject, '后台目录查询应已开始')
    let disposed = false
    const queues = [...(f.service as any).refreshers.values()]
    f.fork.dispose()
    const stop = Promise.all(queues.map(queue => queue.stop())).then(() => { disposed = true })
    await new Promise(r => setTimeout(r, 20))
    assert.equal(disposed, false, '卸载必须等待设备查询结束')
    reject(new Error('卸载期间设备断开'))
    await stop
    assert.equal(f.service.status().refreshFailed, 0, '卸载取消不计为查询故障，也不再记录日志')
    assert.equal(f.bot.snapshotCalls, 1)
  } finally { await f.close() }
})

test('全量目录按过滤器安排后台同步，写入队列溢出和最终失败有明确计数', async () => {
  const f = await fixture({ writeCapacity: 16 })
  try {
    assert.equal(await f.service.syncAll(f.session()), 1)
    for (let i = 0; i < 20; i++) f.emit(f.session({ message_id: `capacity-${i}` }))
    await f.service.flush()
    assert.equal(f.service.status().dropped, 4)
    assert.equal((await f.service.messages(f.session())).length, 16)
    f.app.database.create = (async () => { throw new Error('模拟持久故障') }) as any
    f.emit(f.session({ message_id: 'failed' }))
    await f.service.flush()
    assert.equal(f.service.status().failed, 1)
    assert.equal(f.service.status().pending, 0)
  } finally { await f.close() }
})
