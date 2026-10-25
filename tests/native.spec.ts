import assert from 'node:assert/strict'
import { App } from '@koishijs/core'
import server from '@koishijs/plugin-server'
import { WebSocket } from 'ws'
import * as webridge from '../src/index.js'

const address = 'ws://127.0.0.1:16202/webridge/native-test-secret'
const app = new App()
const serverFork = app.plugin(server, { host: '127.0.0.1', port: 16202 })
const fork = app.plugin(webridge, { address, selfId: 'native-test' })
const commands: any[] = [], events: any[] = []
app.on('webridge/moments-result', event => { events.push(event) })
let socket!: WebSocket
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function next(queue: any[]) {
  for (let i = 0; !queue.length && i < 200; i++) await sleep(10)
  assert.ok(queue.length, '等待命令或事件超时')
  return queue.shift()
}
function reply(command: any, result: Record<string, unknown>, ok = true) {
  socket.send(JSON.stringify({ type: 'command_result', request_id: command.request_id,
    command_name: command.command_name, ok, error: ok ? '' : 'device-error', result }))
}

await app.start()
try {
  socket = new WebSocket(address)
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  const ack = new Promise<void>(resolve => socket.on('message', raw => {
    const frame = JSON.parse(String(raw))
    if (frame.type === 'hello_ack') resolve()
    else if (frame.command_name === 'account_status') reply(frame, { nick_name: '原生接口测试' })
    else commands.push(frame)
  }))
  // 作者明确说明收藏、星标、黑名单等存在清单缺口；接口调用不能被清单挡掉。
  socket.send(JSON.stringify({ type: 'hello', device_id: 'native-device', session_id: 'native-session',
    account_id: 'wxid_bot', capabilities: ['account_status'], state: { is_logged_in: true } }))
  await ack
  const bot = app.bots[0] as unknown as webridge.WebridgeBot
  const api = bot.internal as webridge.WebridgeInternal

  const reading = api.call('favorites_list', { refresh: true, limit: 50 })
  const favorites = await next(commands)
  assert.equal(favorites.command_name, 'favorites_list')
  reply(favorites, { items: [], has_more: false })
  assert.deepEqual(await reading, { items: [], has_more: false })

  const search = api.call('official_account_search', { keyword: '示例' })
  const searching = await next(commands)
  assert.deepEqual(searching.args, { keyword: '示例' })
  reply(searching, { error_code: 'REQUEST_TIMEOUT', message: '搜索超时', search_diagnostics: { request_cgi: 719 } }, false)
  await assert.rejects(search, (error: any) => {
    assert.ok(error instanceof webridge.WebridgeCommandError)
    assert.equal(error.code, 'REQUEST_TIMEOUT')
    assert.equal(error.requestId, searching.request_id)
    assert.deepEqual(error.result.search_diagnostics, { request_cgi: 719 })
    return true
  })
  console.log('PASS 清单缺口不拦截原生接口；公众号错误码、诊断和请求 ID 保留')

  const setting = api.call('set_friend_star', { id: 'wxid_friend', starred: false })
  const star = await next(commands)
  assert.equal(star.args.starred, false)
  reply(star, { status: 'unchanged', server_confirmed: false, local_verified: true })
  assert.equal((await setting).server_confirmed, false)
  const management = api.call('group_admin_operate', { room_id: '123@chatroom', oper_type: 1, member_ids: ['wxid_friend'] })
  const manager = await next(commands)
  reply(manager, { status: 'unknown', error_code: 'OPERATION_TIMEOUT', accepted: true }, false)
  await assert.rejects(management, (error: any) => error.result.status === 'unknown' && error.result.accepted === true)
  assert.equal(commands.length, 0, '结果未知不得自动重发写入')

  const id = '18446744073709551615'
  const pending = api.call('moments_detail', { sns_id: id })
  const detail = await next(commands)
  assert.equal(detail.args.sns_id, id)
  reply(detail, { operation_id: 'operation-example', status: 'pending', accepted: true, server_confirmed: false })
  assert.equal((await pending).status, 'pending', '受理不得包装成已完成')
  for (const revision of [1, 1, 2]) socket.send(JSON.stringify({ type: 'event', event_name: 'moments_result',
    event_id: `msg:moments:operation-example:${revision}`, account_id: 'wxid_bot',
    body: { operation_id: 'operation-example', revision, status: 'succeeded', server_confirmed: true } }))
  assert.equal((await next(events)).body.revision, 1)
  assert.equal((await next(events)).body.revision, 2)
  assert.equal(events.length, 0)
  const pollIds: string[] = []
  for (let i = 0; i < 2; i++) {
    const poll = api.call('moments_operation', { operation_id: 'operation-example' })
    const command = await next(commands)
    pollIds.push(command.request_id)
    reply(command, { status: 'pending' })
    await poll
  }
  assert.notEqual(pollIds[0], pollIds[1], '朋友圈轮询必须生成新的信封 ID')
  console.log('PASS 本地同步状态、群管理结果未知、朋友圈受理/完成、revision 去重及大整数 ID')

  assert.throws(() => api.call('upload_file_to_wechat_cdn', { file_url: 'https://example.com/demo.pdf' }), /requestId/)
  for (let i = 0; i < 2; i++) {
    const upload = api.uploadFileToWechatCdn({ file_url: 'https://example.com/demo.pdf' }, { requestId: 'cdn-original' })
    const command = await next(commands)
    assert.equal(command.request_id, 'cdn-original')
    assert.equal(command.args.request_id, undefined)
    reply(command, i === 0 ? { error_code: 'media_timeout', pending: true } : { uploaded: true, pending: false }, i !== 0)
    if (i === 0) await assert.rejects(upload, (error: any) => error.code === 'media_timeout' && error.result.pending)
    else assert.equal((await upload).uploaded, true)
  }
  const first = api.call('favorites_send', { fav_id: '123', receiver: 'wxid_friend' }, { requestId: 'stable-send-id' })
  const firstCommand = await next(commands)
  reply({ ...firstCommand, command_name: 'favorites_delete' }, { status: 'deleted' })
  await sleep(20)
  assert.equal((bot as any).pending.has('stable-send-id'), true, '错误命令名不能认领同 ID 的结果')
  await assert.rejects(api.call('favorites_send', { fav_id: '123', receiver: 'wxid_friend' }, { requestId: 'stable-send-id' }), /仍在等待/)
  reply(firstCommand, { status: 'accepted' })
  assert.equal((await first).status, 'accepted')
  const timed = api.call('get_self_qrcode', {}, { timeout: 20, requestId: 'qr-timeout' })
  await next(commands)
  await assert.rejects(timed, (error: any) => error.code === 'command-timeout' && error.requestId === 'qr-timeout')
  assert.equal((bot as any).pending.size, 0)
  const interrupted = api.call('get_group_invitation', { message_id: '123' }, { requestId: 'invitation-interrupted' })
  await next(commands)
  socket.close()
  await assert.rejects(interrupted, (error: any) => error instanceof webridge.WebridgeTransportError
    && error.code === 'disconnected' && error.requestId === 'invitation-interrupted')
  console.log('PASS CDN 显式复用真实信封 ID、并发重复 ID 拒绝、超时保留查询标识并清理等待')
} finally {
  socket?.close()
  await fork.dispose()
  await serverFork.dispose()
  await app.stop()
}
