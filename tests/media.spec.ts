import assert from 'node:assert/strict'
import { App, h } from '@koishijs/core'
import server from '@koishijs/plugin-server'
import { WebSocket } from 'ws'
import * as webridge from '../src/index.js'
import { imageMime } from '../src/media.js'
import { createHash } from 'node:crypto'
import { encode } from 'silk-wasm'

const origin = 'http://127.0.0.1:16201'
const address = `${origin.replace('http:', 'ws:')}/webridge/media-test-secret`
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const app = new App()
const serverFork = app.plugin(server, { host: '127.0.0.1', port: 16201 })
const fork = app.plugin(webridge, { address, selfId: 'media-test', inboundMediaTimeout: 1000, inboundMediaMaxBytes: 1024 })
const sessions: any[] = []
const commands: any[] = []
const uploads = new Map<string, any>()
app.on('message', session => { sessions.push(session) })
let socket!: WebSocket
let serial = 0
const reply = (cmd: any, result: object = { uploaded: true, asset_id: String(cmd.args?.upload_url ?? '').split('/').pop() }, ok = true) => socket.send(JSON.stringify({
  type: 'command_result', request_id: cmd.request_id, command_name: cmd.command_name, ok, result,
}))
async function next<T>(queue: T[]): Promise<T> {
  const end = Date.now() + 3000
  while (!queue.length && Date.now() < end) await sleep(10)
  assert.ok(queue.length, '等待事件/命令超时')
  return queue.shift()!
}
async function connect() {
  socket = new WebSocket(address)
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  const ack = new Promise<void>(resolve => socket.on('message', raw => {
    const frame = JSON.parse(String(raw))
    if (frame.type === 'hello_ack') resolve()
    else if (frame.command_name === 'account_status') reply(frame, { nick_name: '媒体测试' })
    else if (frame.command_name === 'room_members') reply(frame, { room_id: frame.args.room_id, members: [] })
    else { commands.push(frame); if (frame.args?.upload_url) uploads.set(frame.args.upload_url, frame) }
  }))
  socket.send(JSON.stringify({ type: 'hello', device_id: 'media-device', session_id: `session-${++serial}`,
    account_id: 'wxid_bot', capabilities: ['upload_message_media'], state: { is_logged_in: true } }))
  await ack
}
function send(type: string, id: string, channel = 'wxid_user', fields: object = {}) {
  socket.send(JSON.stringify({ type: 'event', event_name: 'message', event_id: `event-${id}`, account_id: 'wxid_bot',
    body: { message_id: id, sender_id: channel, chat_id: channel, is_group: false, msg_type: type,
      create_time: Date.now() / 1000, content: type === 'text' ? id : '', ...fields } }))
}
async function upload(url: string, bytes = png, options: { field?: string, messageId?: string, fields?: Record<string, string> } = {}) {
  const form = new FormData()
  // 手机上传的是 file 字段，MIME 可能只是 application/octet-stream。
  form.append(options.field ?? 'file', new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }), 'image_upload.bin')
  const command = uploads.get(url)
  if (command) {
    const fields = { message_id: options.messageId ?? command.args.message_id, command_request_id: command.request_id,
      media_type: command.args.media_type, account_id: 'wxid_bot', file_size: String(bytes.length),
      md5: createHash('md5').update(bytes).digest('hex'), file_name: 'media.bin', ...options.fields }
    for (const [key, value] of Object.entries(fields)) form.append(key, String(value))
  }
  return fetch(url, { method: 'POST', body: form })
}

await app.start()
try {
  await connect()
  send('image', 'image-1')
  const cmd = await next<any>(commands)
  assert.equal(cmd.command_name, 'upload_message_media')
  assert.equal(cmd.args.message_id, 'image-1')
  assert.ok(!cmd.args.upload_url.includes('media-test-secret'), '上传地址不能泄露 WebSocket 密钥')
  send('text', 'after-image')
  send('text', 'another-channel', 'wxid_other')
  assert.equal((await next<any>(sessions)).content, 'another-channel', '一人的图片不能阻塞其他会话')
  assert.equal((await upload(cmd.args.upload_url, png, { messageId: 'image-1' })).status, 200)
  assert.equal((await upload(cmd.args.upload_url)).status, 404, '同一令牌不能重复上传')
  assert.equal(sessions.length, 0, '必须等设备命令成功后再投递图片')
  reply(cmd)
  const image = await next<any>(sessions)
  assert.equal(image.isDirect, true)
  const element = image.elements.find((item: h) => item.type === 'img')
  assert.equal(element.attrs.src, `data:image/png;base64,${png.toString('base64')}`)
  // 模拟只理解 Koishi 标准消息的业务插件：从 content 解析 src，不读取 session.webridge。
  assert.equal(h.parse(image.content)[0].attrs.src, element.attrs.src)
  assert.deepEqual(Buffer.from(element.attrs.src.split(',')[1], 'base64'), png)
  assert.equal(image.webridge.media[0].status, 'ready')
  assert.equal(image.webridge.media[0].size, png.length)
  assert.equal((await next<any>(sessions)).content, 'after-image', '图片后的文字必须保持顺序')
  assert.equal((await upload(cmd.args.upload_url)).status, 404)
  console.log('PASS 真实 multipart → 标准 img.src；回执确认、一次性令牌、同会话有序和跨会话隔离')

  for (const [id, body, field, reason, status] of [
    ['oversize', Buffer.alloc(1025), 'file', 'too-large', 413],
    ['encrypted', Buffer.alloc(64, 3), 'file', 'unsupported-media-format', 400],
    ['wrong-field', png, 'other', 'invalid-payload', 400],
  ] as const) {
    send('image', id)
    const command = await next<any>(commands)
    assert.equal((await upload(command.args.upload_url, body, { field })).status, status)
    reply(command)
    const session = await next<any>(sessions)
    assert.equal(session.webridge.media[0].reason, reason)
    assert.ok(!session.elements.some((item: h) => item.type === 'img'))
  }
  assert.equal(imageMime(Buffer.from('<svg onload="alert(1)"></svg>')), undefined)
  assert.equal((await fetch(`${origin}/webridge/media/upload/unknown`, { method: 'POST', body: 'untrusted' })).status, 404)
  console.log('PASS 超限、密文、错误字段、主动内容及未知令牌不会变成可用图片')

  // 回执在上传前到达，不能提前给业务插件发空图片。
  send('image', 'result-first')
  const resultFirst = await next<any>(commands)
  reply(resultFirst)
  await sleep(20)
  assert.equal(sessions.length, 0)
  assert.equal((await upload(resultFirst.args.upload_url)).status, 200)
  assert.equal((await next<any>(sessions)).webridge.media[0].status, 'ready')

  send('image', 'device-rejected')
  const rejected = await next<any>(commands)
  reply(rejected, { uploaded: false })
  assert.equal((await next<any>(sessions)).webridge.media[0].reason, 'device-rejected')
  assert.equal((await upload(rejected.args.upload_url)).status, 404)

  send('image', 'timeout')
  const timed = await next<any>(commands)
  reply(timed)
  send('text', 'after-timeout')
  assert.equal((await next<any>(sessions)).webridge.media[0].reason, 'timeout')
  assert.equal((await next<any>(sessions)).content, 'after-timeout')
  assert.equal((await upload(timed.args.upload_url)).status, 404)
  console.log('PASS 回执先到、设备拒绝、超时降级并释放后续消息')

  send('image', 'wrong-message')
  const mismatched = await next<any>(commands)
  assert.equal((await upload(mismatched.args.upload_url, png, { messageId: 'another-message' })).status, 400)
  reply(mismatched)
  assert.equal((await next<any>(sessions)).webridge.media[0].reason, 'message-id-mismatch')

  // 收件限额必须包括“已经上传、尚未拿到命令回执”的图片。
  const pending: any[] = []
  for (let i = 0; i < 4; i++) {
    send('image', `parallel-${i}`, `wxid_parallel_${i}`)
    const command = await next<any>(commands)
    pending.push(command)
    assert.equal((await upload(command.args.upload_url)).status, 200)
  }
  send('image', 'too-many', 'wxid_parallel_overflow')
  assert.equal((await next<any>(sessions)).webridge.media[0].reason, 'busy')
  for (const command of pending) reply(command)
  for (let i = 0; i < 4; i++) assert.equal((await next<any>(sessions)).webridge.media[0].status, 'ready')

  // 关闭接收时不触发设备上传；重新开启后仍可正常收件。
  const bot = app.bots[0] as unknown as webridge.WebridgeBot
  bot.config.acceptMedia = false
  send('image', 'disabled')
  send('text', 'after-disabled')
  assert.equal((await next<any>(sessions)).content, 'after-disabled')
  assert.equal(commands.length, 0)
  bot.config.acceptMedia = true

  send('image', 'group-image', 'wxid_member', { chat_id: '123@chatroom', room_id: '123@chatroom', is_group: true })
  const groupImage = await next<any>(commands)
  await upload(groupImage.args.upload_url)
  reply(groupImage)
  const group = await next<any>(sessions)
  assert.equal(group.isDirect, false)
  assert.equal(group.guildId, '123@chatroom')
  assert.ok(group.elements.find((item: h) => item.type === 'img').attrs.src.startsWith('data:image/png;'))
  console.log('PASS 消息关联、并发资源上限、接收开关及群聊标准图片')

  const silk = Buffer.from((await encode(Buffer.alloc(4800), 24_000)).data)
  const movie = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex')
  const document = Buffer.from('file content')
  for (const [kind, elementType, fields, expected] of [
    ['emoji', 'img', {}, png],
    ['voice', 'audio', {}, silk],
    ['video', 'video', {}, movie],
    ['app', 'file', { msg_subtype: 'file' }, document],
  ] as const) {
    send(kind, `standard-${elementType}`, 'wxid_user', fields)
    const command = await next<any>(commands)
    assert.equal(command.command_name, 'upload_message_media')
    assert.equal(command.args.media_type, kind === 'app' ? 'file' : kind)
    assert.equal(command.args.timeout_seconds, 1)
    assert.equal((await upload(command.args.upload_url, expected, { fields: { file_name: 'C:\\temp\\report.txt' } })).status, 200)
    reply(command)
    const session = await next<any>(sessions)
    const resource = h.parse(session.content).find(item => item.type === elementType)
    assert.ok(resource?.attrs.src, `普通插件应直接读到 ${elementType}.src`)
    const bytes = Buffer.from(String(resource.attrs.src).split(',')[1], 'base64')
    if (kind === 'voice') {
      assert.equal(bytes.toString('ascii', 0, 4), 'RIFF')
      assert.equal(session.webridge.media[0].sourceMime, 'audio/silk')
      assert.equal(resource.attrs.title, 'voice.wav')
    } else assert.deepEqual(bytes, expected)
    assert.equal(session.webridge.media[0].status, 'ready')
    if (elementType === 'file') assert.equal(resource.attrs.title, 'report.txt')
  }
  console.log('PASS 五类媒体经手机 multipart 回传为标准元素，SILK 解码为 WAV，不依赖 CDN URL')

  for (const [field, value, reason] of [
    ['command_request_id', 'another-command', 'request-id-mismatch'],
    ['account_id', 'another-account', 'account-id-mismatch'],
    ['media_type', 'video', 'media-type-mismatch'],
    ['md5', '00000000000000000000000000000000', 'integrity-mismatch'],
    ['file_size', '1', 'size-mismatch'],
  ]) {
    send('image', `invalid-${field}`)
    const command = await next<any>(commands)
    assert.equal((await upload(command.args.upload_url, png, { fields: { [field]: value } })).status, 400)
    reply(command)
    assert.equal((await next<any>(sessions)).webridge.media[0].reason, reason)
  }
  console.log('PASS 拒绝跨命令、跨账号、类型不符、摘要不符和大小不符的回传')

  const sibling = app.plugin(webridge.WebridgeBot as any, {
    address: `${origin.replace('http:', 'ws:')}/webridge/sibling-secret`, selfId: 'sibling', inboundMediaTimeout: 1000,
  })
  const other = new WebSocket(`${origin.replace('http:', 'ws:')}/webridge/sibling-secret`)
  const otherCommands: any[] = []
  try {
    await new Promise<void>((resolve, reject) => { other.once('open', resolve); other.once('error', reject) })
    const otherReply = (command: any) => other.send(JSON.stringify({ type: 'command_result',
      request_id: command.request_id, command_name: command.command_name, ok: true, result: { uploaded: true, asset_id: command.args.upload_url?.split('/').pop() } }))
    const otherAck = new Promise<void>(resolve => other.on('message', raw => {
      const frame = JSON.parse(String(raw))
      if (frame.type === 'hello_ack') resolve()
      else if (frame.command_name === 'account_status') otherReply(frame)
      else { otherCommands.push(frame); if (frame.args?.upload_url) uploads.set(frame.args.upload_url, frame) }
    }))
    other.send(JSON.stringify({ type: 'hello', device_id: 'other-device', session_id: 'other-session',
      account_id: 'wxid_other_bot', capabilities: ['upload_message_media'], state: { is_logged_in: true } }))
    await otherAck
    send('image', 'main-account')
    other.send(JSON.stringify({ type: 'event', event_name: 'message', event_id: 'other-account', account_id: 'wxid_other_bot',
      body: { message_id: 'other-image', msg_type: 'image', chat_id: 'wxid_other_friend', sender_id: 'wxid_other_friend' } }))
    const mainUpload = await next<any>(commands)
    const otherUpload = await next<any>(otherCommands)
    assert.notEqual(new URL(mainUpload.args.upload_url).pathname.split('/').slice(0, -1).join('/'),
      new URL(otherUpload.args.upload_url).pathname.split('/').slice(0, -1).join('/'))
    assert.equal((await upload(otherUpload.args.upload_url, png, { fields: { account_id: 'wxid_other_bot' } })).status, 200)
    otherReply(otherUpload)
    assert.equal((await next<any>(sessions)).bot.selfId, 'sibling')
    assert.equal((await upload(mainUpload.args.upload_url)).status, 200)
    reply(mainUpload)
    assert.equal((await next<any>(sessions)).bot.selfId, 'media-test')
  } finally {
    other.close()
    await sibling.dispose()
  }
  console.log('PASS 相同路由前缀下多账号独立取件，无上传串号')

  for (const type of ['voice', 'video', 'emoji', 'app']) {
    send(type, `unsupported-${type}`, 'wxid_user', type === 'app' ? { msg_subtype: 'file' } : {})
    const command = await next<any>(commands)
    reply(command, { error_code: 'unsupported_media_type', message: '测试原生取件失败' }, false)
    const session = await next<any>(sessions)
    assert.equal(session.webridge.media[0].reason, 'unsupported_media_type')
    assert.ok(session.content.includes('内容暂不可用'))
    assert.ok(session.elements.every((item: h) => item.type === 'text'))
  }
  assert.equal(commands.length, 0)

  send('image', 'before-disconnect')
  const stale = await next<any>(commands)
  socket.close()
  await new Promise<void>(resolve => socket.once('close', resolve))
  await connect()
  send('text', 'new-connection')
  assert.equal((await next<any>(sessions)).content, 'new-connection', '旧连接图片不能污染新会话')
  assert.equal((await upload(stale.args.upload_url)).status, 404)
  console.log('PASS 不支持媒体明确降级；断线取消、重连与旧令牌隔离')

  send('image', 'before-unload')
  const unloading = await next<any>(commands)
  await fork.dispose()
  assert.equal((await upload(unloading.args.upload_url)).status, 404, '卸载后上传路由必须清理')
  console.log('PASS 卸载清理媒体等待与路由')
} finally {
  socket?.close()
  await fork.dispose()
  await serverFork.dispose()
  await app.stop()
}
