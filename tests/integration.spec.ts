import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App, type Session } from '@koishijs/core'
import server from '@koishijs/plugin-server'
import sqlite from '@koishijs/plugin-database-sqlite'
import { WebSocket } from 'ws'
import * as source from '../src/index.js'
import type { WebridgeBot } from '../src/bot.js'

const require = createRequire(import.meta.url)
const adapter = process.env.WEBRIDGE_PACKAGE ? require(process.env.WEBRIDGE_PACKAGE) : source
const unwrap = (value: any) => value.default ?? value
async function fixture(database: boolean, enabled: boolean, existing?: string, filter: unknown = true, omitRoomNickname = false) {
  const dir = existing ?? await mkdtemp(join(tmpdir(), 'webridge-integrated-'))
  const reserve = createServer()
  await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve))
  const port = (reserve.address() as { port: number }).port
  await new Promise<void>(resolve => reserve.close(() => resolve()))
  const app = new App()
  const serverFork = app.plugin(unwrap(server), { host: '127.0.0.1', port })
  const databaseFork = database ? app.plugin(unwrap(sqlite), { path: join(dir, 'archive.db') }) : undefined
  const adapterFork = app.plugin(adapter, { address: `ws://127.0.0.1:${port}/test/fixture-secret`, selfId: 'fixture',
    archive: { enabled, autoRefresh: false, filter }, directoryTimeout: 100, acceptMedia: false })
  const messages: Session[] = []
  app.on('message', session => { messages.push(session) })
  await app.start()
  const bot = app.bots[0] as unknown as WebridgeBot
  let queries = 0
  let roomNickname: string | undefined = omitRoomNickname ? undefined : '标准群昵称'
  const ws = new WebSocket(`ws://127.0.0.1:${port}/test/fixture-secret`)
  const wait = async (predicate: () => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return
      await new Promise(r => setTimeout(r, 10))
    }
    throw new Error('等待测试状态超时')
  }
  let ack = false
  ws.on('message', data => {
    const frame = JSON.parse(String(data))
    if (frame.type === 'hello_ack') ack = true
    if (frame.type !== 'command') return
    if (frame.command_name === 'room_members') queries++
    const result = frame.command_name === 'room_members' ? {
      room_id: frame.args.room_id, room_name: '实际群名', room_remark: '',
      members: [{ account_id: 'alice', nick_name: '个人昵称', ...(roomNickname === undefined ? {} : { room_nick_name: roomNickname }) }],
    } : { items: [] }
    ws.send(JSON.stringify({ type: 'command_result', request_id: frame.request_id, command_name: frame.command_name,
      ok: true, result, device_id: 'fixture-device', session_id: 'fixture-session', account_id: 'wxid_fixture' }))
  })
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  ws.send(JSON.stringify({ type: 'hello', device_id: 'fixture-device', session_id: 'fixture-session', account_id: 'wxid_fixture',
    runtime_version: '0.8.79', ts_ms: Date.now(), state: { is_logged_in: true, plugin_enabled: true } }))
  await wait(() => ack)
  const emit = (id: string, extra: object = {}) => ws.send(JSON.stringify({ type: 'event', device_id: 'fixture-device',
    session_id: 'fixture-session', account_id: 'wxid_fixture', event_name: 'message', event_id: id, captured_at_ms: Date.now(),
    body: { message_id: id, chat_id: 'group@chatroom', room_id: 'group@chatroom', sender_id: 'alice', is_group: true,
      msg_type: 'text', content: '测试正文', create_time: Date.now() / 1000, ...extra } }))
  let closed = false
  async function close(clean = true) {
    if (closed) return
    closed = true
    ws.close()
    await adapterFork.dispose()
    await databaseFork?.dispose()
    await serverFork.dispose()
    await app.stop()
    assert.ok(dir.startsWith(join(tmpdir(), 'webridge-integrated-')))
    if (clean) await rm(dir, { recursive: true, force: true })
  }
  return { app, bot, emit, messages, wait, close, dir, queries: () => queries, setRoomNickname(value: string | undefined) { roomNickname = value } }
}

test('真实 Koishi 与 WebSocket：无数据库也能补齐群昵称，标准查询复用同群缓存', async () => {
  const f = await fixture(false, false)
  try {
    assert.equal(f.bot.archive, undefined)
    f.emit('first'); f.emit('second')
    await f.wait(() => f.messages.length === 2)
    assert.equal(f.messages[0].username, '标准群昵称')
    assert.equal(f.messages[0].event.guild?.name, '实际群名')
    assert.equal((await f.bot.getGuildMember('group@chatroom', 'alice')).nick, '标准群昵称')
    assert.equal(f.queries(), 1)
  } finally { await f.close() }
})

test('开启归档但没有数据库不会阻止适配器加载和昵称补全', async () => {
  const f = await fixture(false, true)
  try {
    f.emit('without-db'); await f.wait(() => f.messages.length === 1)
    assert.equal(f.bot.archive, undefined)
    assert.equal(f.messages[0].username, '标准群昵称')
  } finally { await f.close() }
})

test('单独安装适配器即可归档：复用旧表、重启保留历史，记录自发与过滤媒体', async () => {
  const f = await fixture(true, true)
  try {
    assert.ok(f.bot.archive)
    f.emit('normal'); f.emit('self', { sender_id: 'wxid_fixture' }); f.emit('image', { msg_type: 'image' })
    await f.wait(() => f.bot.archive!.status().written >= 3 && f.messages.length === 1)
    await f.bot.archive!.flush()
    assert.equal((await f.app.database.get('wechat.archive.message', {})).length, 3)
    assert.equal(f.messages.length, 1)
    const s = f.messages[0]
    await f.bot.archive!.syncGroup(s as any)
    assert.equal((await f.bot.archive!.member(s as any, 'alice')).roomNickname, '标准群昵称')
    await f.close(false)
    const restarted = await fixture(true, true, f.dir)
    try {
      assert.equal((await restarted.app.database.get('wechat.archive.message', {})).length, 3)
      assert.equal((await restarted.app.database.get('wechat.archive.member', {}))[0].roomNickname, '标准群昵称')
    } finally { await restarted.close() }
  } catch (error) { await f.close(); throw error }
})

test('内置归档保留独立过滤范围，范围外消息仍可正常获取昵称', async () => {
  const f = await fixture(true, true, undefined, { $eq: [{ $: 'channelId' }, 'allowed@chatroom'] })
  try {
    f.emit('outside')
    await f.wait(() => f.messages.length === 1)
    f.emit('inside', { room_id: 'allowed@chatroom', chat_id: 'allowed@chatroom' })
    await f.wait(() => f.messages.length === 2 && f.bot.archive!.status().written >= 1)
    await f.bot.archive!.flush()
    const rows = await f.app.database.get('wechat.archive.message', {})
    assert.equal(rows.length, 1)
    assert.equal(rows[0].channelId, 'allowed@chatroom')
    assert.ok(f.messages.every(session => session.username === '标准群昵称'))
  } finally { await f.close() }
})

test('多个适配器各自归档，不会重复写入或跨机器人查询', async () => {
  const f = await fixture(true, true)
  const fork = f.app.plugin(adapter, { address: 'ws://127.0.0.1:1/second/fixture-secret', selfId: 'second',
    archive: { enabled: true, autoRefresh: false } })
  try {
    await f.wait(() => f.app.bots.length === 2 && !!(f.app.bots[1] as unknown as WebridgeBot).archive)
    const second = f.app.bots[1] as unknown as WebridgeBot
    second.deviceAccountId = 'wxid_second'
    const session = second.session({ type: 'internal', user: { id: 'alice' },
      channel: { id: 'group@chatroom', type: 0 }, guild: { id: 'group@chatroom' } })
    session.setInternal('webridge', { accountId: 'wxid_second', event_name: 'message', message_id: 'other-bot',
      sender_id: 'alice', msg_type: 'text', content: '另一个账号' })
    f.app.emit(session as any, 'webridge/archive-event', session as any)
    await second.archive!.flush()
    assert.equal(second.archive!.status().written, 1)
    assert.equal(f.bot.archive!.status().written, 0)
    await assert.rejects(f.bot.archive!.messages(session as any), /范围/)
  } finally { await fork.dispose(); await f.close() }
})

test('设备未提供群名片时沿用持久目录；标准消息、单人和列表一致，明确清空不回退', async () => {
  const f = await fixture(true, true, undefined, true, true)
  try {
    await f.app.database.upsert('wechat.archive.member', [{ platform: 'webridge', accountId: 'wxid_fixture', channelId: 'group@chatroom',
      userId: 'alice', roomNickname: '保存的群昵称', nickname: '旧个人昵称', membership: 'ACTIVE', updatedAt: new Date() }])
    f.emit('saved-card'); await f.wait(() => f.messages.length === 1)
    assert.equal(f.messages[0].username, '保存的群昵称')
    assert.equal((await f.bot.getGuildMember('group@chatroom', 'alice')).nick, '保存的群昵称')
    assert.equal((await f.bot.getGuildMemberList('group@chatroom')).data[0].nick, '保存的群昵称')
    assert.equal((await f.bot.internal.getGroupSnapshot('group@chatroom')).members[0].room_nick_name, undefined, '不把持久目录伪装成设备快照')
    f.setRoomNickname(''); f.bot.directory.clear()
    assert.equal((await f.bot.getGuildMember('group@chatroom', 'alice')).nick, '个人昵称')
  } finally { await f.close() }
})
