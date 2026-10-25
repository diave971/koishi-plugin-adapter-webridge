import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Context } from '@satorijs/core'
import type { WebridgeBot } from './bot.js'
import { MediaError, prepareMedia, DEFAULT_ATTACHMENT_MAX_BYTES, type MessageMediaKind } from './media-format.js'

export { imageMime } from './media-format.js'
export const DEFAULT_INBOUND_MEDIA_TIMEOUT = 200_000
export const DEFAULT_INBOUND_MEDIA_MAX_BYTES = 5 * 1024 * 1024
const MAX_PENDING_UPLOADS = 4
const MULTIPART_OVERHEAD = 64 * 1024

export interface InboundMediaContent {
  kind: string
  status: 'ready' | 'unavailable'
  src?: string
  mime?: string
  size?: number
  filename?: string
  sourceMime?: string
  durationMs?: number
  reason?: string
}

interface PendingUpload {
  messageId: string
  requestId: string
  accountId?: string
  kind: MessageMediaKind
  uploading: boolean
  resolve: (content: InboundMediaContent) => void
  reject: (error: MediaError) => void
  request?: IncomingMessage
}

async function readUpload(request: IncomingMessage, limit: number): Promise<Buffer> {
  const length = request.headers['content-length']
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw new MediaError('too-large')
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > limit) throw new MediaError('too-large')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, size)
}

/** 五类媒体统一由手机原生取件。令牌只绑定一次命令，不接受任意上传或下载代理。 */
export class InboundMediaReceiver {
  private pending = new Map<string, PendingUpload>()
  private layer?: Context['server']['stack'][number]

  constructor(private bot: WebridgeBot, private path: string, private publicUrl: (suffix: string) => string) {}

  private maxBytes(kind: MessageMediaKind): number {
    return kind === 'image' || kind === 'emoji' ? this.bot.config.inboundMediaMaxBytes ?? DEFAULT_INBOUND_MEDIA_MAX_BYTES
      : this.bot.config.inboundAttachmentMaxBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES
  }

  start(): void {
    const handler = async (koa: any) => {
      const token = String(koa.params.token)
      const entry = this.pending.get(token)
      // 先鉴权再读正文；匿名请求不占 multipart 临时文件和解码额度。
      if (!entry || entry.uploading) { koa.status = 404; return }
      entry.uploading = true
      entry.request = koa.req
      try {
        const contentType = String(koa.request.headers['content-type'] ?? '')
        if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new MediaError('invalid-payload')
        const max = this.maxBytes(entry.kind)
        const body = await readUpload(koa.req, max + MULTIPART_OVERHEAD)
        if (this.pending.get(token) !== entry) throw new MediaError('cancelled')
        const form = await new Response(new Uint8Array(body), { headers: { 'content-type': contentType } }).formData()
        if (form.get('message_id') !== entry.messageId) throw new MediaError('message-id-mismatch')
        if (form.get('command_request_id') !== entry.requestId) throw new MediaError('request-id-mismatch')
        if (form.get('media_type') !== entry.kind) throw new MediaError('media-type-mismatch')
        if (entry.accountId && form.get('account_id') !== entry.accountId) throw new MediaError('account-id-mismatch')
        const files = form.getAll('file')
        const file = files[0]
        if (files.length !== 1 || !(file instanceof Blob) || !file.size) throw new MediaError('invalid-payload')
        if (file.size > max) throw new MediaError('too-large')
        if (form.get('file_size') !== String(file.size)) throw new MediaError('size-mismatch')
        const bytes = Buffer.from(await file.arrayBuffer())
        const md5 = form.get('md5')
        if (typeof md5 !== 'string' || !/^[a-f\d]{32}$/i.test(md5)
          || createHash('md5').update(bytes).digest('hex') !== md5.toLowerCase()) throw new MediaError('integrity-mismatch')
        const content = await prepareMedia(bytes, entry.kind, max,
          typeof form.get('file_name') === 'string' ? String(form.get('file_name')) : undefined)
        if (this.pending.get(token) !== entry) throw new MediaError('cancelled')
        entry.resolve(content)
        koa.body = { ok: true, asset_id: token }
      } catch (error) {
        const failure = error instanceof MediaError ? error : new MediaError('invalid-payload')
        entry.reject(failure)
        koa.status = failure.reason === 'too-large' ? 413 : 400
        koa.body = { ok: false, error: failure.reason }
      } finally { entry.request = undefined }
    }
    Object.defineProperty(handler, Symbol.for('noParseBody'), { value: true })
    this.layer = this.bot.ctx.server.register(`${this.path}/:token`, ['POST'], handler)
  }

  async receive(messageId: string, kind: MessageMediaKind): Promise<InboundMediaContent> {
    const unavailable = (reason: string): InboundMediaContent => ({ kind, status: 'unavailable', reason })
    if (!messageId) return unavailable('missing-message-id')
    if (this.pending.size >= MAX_PENDING_UPLOADS) return unavailable('busy')
    const token = randomBytes(24).toString('hex')
    const requestId = randomUUID()
    let entry!: PendingUpload
    const uploaded = new Promise<InboundMediaContent>((resolve, reject) => {
      entry = { messageId, kind, requestId, accountId: this.bot.deviceAccountId, resolve, reject, uploading: false }
    })
    this.pending.set(token, entry)
    const timeout = this.bot.config.inboundMediaTimeout ?? DEFAULT_INBOUND_MEDIA_TIMEOUT
    const timer = setTimeout(() => {
      entry.reject(new MediaError('timeout'))
      entry.request?.destroy()
    }, timeout)
    try {
      const [, content] = await Promise.all([
        this.bot.query<Record<string, unknown>>('upload_message_media', {
          message_id: messageId, media_type: kind, upload_url: this.publicUrl(token),
          timeout_seconds: Math.max(1, Math.min(180, Math.ceil((timeout - 1000) / 1000))),
        }, timeout, requestId).then(result => {
          if (result.uploaded !== true || result.asset_id !== token) throw new MediaError('device-rejected')
        }),
        uploaded,
      ])
      return content
    } catch (error) {
      return unavailable(error instanceof MediaError ? error.reason
        : typeof (error as any)?.code === 'string' ? (error as any).code : 'device-rejected')
    } finally {
      clearTimeout(timer)
      this.pending.delete(token)
      entry.request?.destroy()
      this.bot.cancelCommand(requestId)
    }
  }

  cancel(): void {
    for (const entry of this.pending.values()) {
      entry.reject(new MediaError('disconnected'))
      entry.request?.destroy()
    }
    this.pending.clear()
  }

  stop(): void {
    this.cancel()
    const stack = this.bot.ctx.server.stack
    const index = this.layer ? stack.indexOf(this.layer) : -1
    if (index >= 0) stack.splice(index, 1)
    this.layer = undefined
  }
}
