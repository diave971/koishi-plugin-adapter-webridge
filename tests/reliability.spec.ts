import assert from 'node:assert/strict'
import { WebridgeBot } from '../src/bot.js'

const friend: any = Object.create(WebridgeBot.prototype)
const accepted: any[] = []
let requestSession: any
Object.defineProperties(friend, {
  logger: { value: { debug() {}, warn() {} } },
  ctx: { value: { emit() {} } },
})
friend.friendRequests = new Map()
friend.internal = { async acceptFriendRequest(args: any) { accepted.push(args) } }
friend.session = (event: any) => ({ event, setInternal() {} })
friend.dispatch = (session: any) => { requestSession = session }
const request = (id: number, fields: object = {}) => ({
  type: 'event', event_name: 'friend_request', event_id: `request:${id}`,
  captured_at_ms: Date.now(),
  body: { message_id: `message:${id}`, encrypt_username: 'encrypted-test', ticket: 'test-ticket',
    request_id: `business:${id}`, scene: 3, ...fields },
})
friend.dispatchPlatformEvent(request(1))
assert.equal(requestSession.event.message.id, 'message:1')
assert.equal(friend.friendRequests.size, 1)
await friend.handleFriendRequest('message:1', true)
assert.deepEqual(accepted[0], {
  encryptUsername: 'encrypted-test', ticket: 'test-ticket', requestId: 'business:1', scene: 3,
})
assert.equal(friend.friendRequests.size, 0)
friend.dispatchPlatformEvent(request(2, { message_id: undefined }))
assert.equal(requestSession.event.message.id, 'request:2')
await friend.handleFriendRequest('request:2', true)
friend.dispatchPlatformEvent(request(3))
await friend.handleFriendRequest('request:3', true)
assert.equal(friend.friendRequests.size, 0, '按事件 ID 处理后也应删除原记录')
friend.dispatchPlatformEvent(request(4, { ticket: undefined }))
await assert.rejects(friend.handleFriendRequest('message:4', true), /缺少/)
for (let i = 10; i < 220; i++) friend.dispatchPlatformEvent(request(i))
assert.equal(friend.friendRequests.size, 200)
await assert.rejects(friend.handleFriendRequest('message:10', true), /没有找到/)
console.log('PASS 好友申请派发、同意、事件 ID 兜底、字段校验及缓存淘汰')

const echo: any = Object.create(WebridgeBot.prototype)
echo.echoWaiters = []
echo.config = { echoTimeout: 20 }
const selfEcho = (text: string, id: string, quoteId?: string) => ({
  type: 'event', event_name: 'message',
  body: { room_id: '123@chatroom', message_id: id, msg_type: quoteId ? 'app' : 'text',
    msg_subtype: quoteId ? 'quote' : undefined, quote_msg_id: quoteId,
    content: quoteId ? `<msg><appmsg><title>${text}</title></appmsg></msg>` : text },
})
const ordinary = echo.waitForSelfEcho('123@chatroom', '确认操作')
echo.settleSelfEcho(selfEcho('不要确认操作', 'wrong'))
assert.equal(echo.echoWaiters.length, 1)
echo.settleSelfEcho(selfEcho('确认操作', 'correct'))
assert.equal(await ordinary.wait(), 'correct')
const firstQuote = echo.waitForSelfEcho('123@chatroom', '第一条回复', 'original')
const secondQuote = echo.waitForSelfEcho('123@chatroom', '第二条回复', 'original')
echo.settleSelfEcho(selfEcho('不相关的回复', 'wrong', 'original'))
echo.settleSelfEcho(selfEcho('第一条回复', 'wrong-target', 'another'))
assert.equal(echo.echoWaiters.length, 2)
echo.settleSelfEcho(selfEcho('第二条回复', 'second', 'original'))
echo.settleSelfEcho(selfEcho('第一条回复', 'first', 'original'))
assert.equal(await secondQuote.wait(), 'second')
assert.equal(await firstQuote.wait(), 'first')
const timedOut = echo.waitForSelfEcho('123@chatroom', '没有回推')
assert.equal(await timedOut.wait(), undefined)
const cancelled = echo.waitForSelfEcho('123@chatroom', '取消')
cancelled.cancel()
assert.equal(await cancelled.wait(), undefined)
assert.equal(echo.echoWaiters.length, 0)
const duplicateA = echo.waitForSelfEcho('123@chatroom', '同样的回复')
const duplicateB = echo.waitForSelfEcho('123@chatroom', '同样的回复')
echo.settleSelfEcho(selfEcho('同样的回复', 'ambiguous'))
assert.equal(await duplicateA.wait(), undefined)
assert.equal(await duplicateB.wait(), undefined)
console.log('PASS 普通回推拒绝后缀误匹配；同一引用目标的乱序回复按正文正确认领；超时及取消清理')
