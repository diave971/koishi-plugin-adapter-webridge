import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WebridgeDirectory } from '../src/directory.js'
import { contactToGuildMember } from '../src/contacts.js'
import type { EventFrame, RoomMembersResult } from '../src/types.js'

const room = 'a@chatroom'
const snapshot = (nick = '群名片', guildId = room) => ({ room_id: guildId, room_name: '群名', room_remark: '群备注',
  members: [{ account_id: 'alice', display_name: '本机备注', nick_name: '微信昵称', room_nick_name: nick }] }) as RoomMembersResult
const session = (guildId = room) => ({ guildId, userId: 'alice', event: {
  user: { id: 'alice', name: 'alice' }, guild: { id: guildId }, channel: { id: guildId, type: 0 },
} }) as any

test('无数据库：同群并发合并、消息与标准查询使用群名片，群之间隔离', async () => {
  let calls = 0
  const directory = new WebridgeDirectory(async guild => { calls++; return snapshot(guild, guild) }, () => 'account')
  const [a, b] = [session(), session()]
  await Promise.all([directory.enrich(a, 100), directory.enrich(b, 100), directory.snapshot(room)])
  assert.equal(calls, 1)
  assert.equal(a.event.member.nick, room)
  assert.equal(a.event.user.nick, '微信昵称')
  assert.equal(a.event.guild.name, '群备注')
  assert.equal(b.event.member.nick, room)
  assert.equal(contactToGuildMember((await directory.snapshot('b@chatroom')).members[0]).nick, 'b@chatroom')
  assert.equal(calls, 2)
})

test('账号切换丢弃旧查询结果，旧会话不会被新账号资料补全', async () => {
  let resolve!: (raw: RoomMembersResult) => void, account = 'first'
  const directory = new WebridgeDirectory(() => new Promise(r => { resolve = r }), () => account)
  const s = session(), result = directory.enrich(s, 100)
  await new Promise(r => setImmediate(r))
  account = 'second'; directory.clear(); resolve(snapshot('旧账号群名片'))
  await result
  assert.equal(s.event.member, undefined)
})

test('改名与清空立即生效；入群顶层群名不污染昵称，旧快照不覆盖增量', async () => {
  let raw = snapshot(), resolve!: (raw: RoomMembersResult) => void
  const directory = new WebridgeDirectory(async () => raw, () => 'account')
  await directory.snapshot(room)
  const event = (type: string, body: object, at = 100) => ({ event_name: type, body: {
    room_id: room, member_id: 'alice', create_time: at, ...body,
  } }) as EventFrame
  directory.observe(event('group_member_join', { room_nick_name: '不是成员昵称' }))
  const joined = session(); await directory.enrich(joined, 100)
  assert.equal(joined.event.member.nick, '群名片')
  await new Promise(r => setImmediate(r))
  raw = snapshot('设备旧值')
  const source = new WebridgeDirectory(() => new Promise(r => { resolve = r }), () => 'account')
  const pending = source.snapshot(room)
  await new Promise(r => setImmediate(r))
  source.observe(event('group_member_nickname_change', { new_room_nick_name: '更新' }))
  resolve(raw)
  await assert.rejects(pending, /发生变化/)
  directory.observe(event('group_member_nickname_change', { new_room_nick_name: '更新' }, 102))
  const renamed = session(); await directory.enrich(renamed, 100)
  assert.equal(renamed.event.member.nick, '更新')
  directory.observe({ event_name: 'group_member_nickname_change', body: { room_id: room, member_id: 'bob',
    new_room_nick_name: '其他成员', create_time: 200 } } as EventFrame)
  directory.observe(event('group_member_nickname_change', { new_room_nick_name: '不能回退' }, 101))
  directory.observe(event('group_member_nickname_change', { new_room_nick_name: '' }, 103))
  const cleared = session(); await directory.enrich(cleared, 100)
  assert.equal(cleared.event.member.nick, '微信昵称')
})

test('超时继续派发、失败退避、缓存有界且未完成查询不被淘汰', async () => {
  let calls = 0, fail!: (reason: Error) => void
  const directory = new WebridgeDirectory(() => { calls++; return new Promise((_, reject) => { fail = reject }) }, () => 'account', 1000, 1)
  const s = session(); await directory.enrich(s, 5)
  assert.equal(s.event.member, undefined)
  await assert.rejects(directory.snapshot('b@chatroom'), /已满/)
  fail(new Error('offline')); await new Promise(r => setImmediate(r))
  await directory.enrich(session(), 5)
  assert.equal(calls, 1)
  const other = directory.snapshot('b@chatroom')
  await new Promise(r => setImmediate(r)); fail(new Error('offline'))
  await assert.rejects(other, /offline/)
  assert.equal(calls, 2)
})

test('缓存没有新成员时补查一次；确实不存在的成员不会每条消息反复查群', async () => {
  let calls = 0
  const directory = new WebridgeDirectory(async () => { calls++; return snapshot() }, () => 'account')
  await directory.snapshot(room)
  assert.equal(await directory.member(room, 'missing'), undefined)
  assert.equal(await directory.member(room, 'missing'), undefined)
  assert.equal(calls, 2)
})

test('持久目录回退限时且换号后失效，明确空名片不查询旧值', async () => {
  const raw = snapshot(); delete raw.members[0].room_nick_name
  let account = 'first', finish!: (value: Map<string, string>) => void, lookups = 0
  const directory = new WebridgeDirectory(async () => raw, () => account, 300000, 256, () => {
    lookups++; return new Promise(resolve => { finish = resolve })
  })
  const pending = directory.member(room, 'alice')
  await new Promise(resolve => setImmediate(resolve))
  account = 'second'; directory.clear(); finish(new Map([['alice', '旧账号名片']]))
  await assert.rejects(pending, /账号或连接变化/)
  raw.members[0].room_nick_name = ''
  assert.equal((await directory.member(room, 'alice'))?.room_nick_name, '')
  assert.equal(lookups, 1)
  delete raw.members[0].room_nick_name; directory.clear()
  const s = session(); await directory.enrich(s, 5)
  assert.equal(s.event.member.nick, '微信昵称')
  finish(new Map([['alice', '迟到结果']]))
})
