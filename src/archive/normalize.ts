import { createHash } from 'node:crypto'
import type { Session } from '@koishijs/core'
import type { Scope, MessageRow, EventRow } from './schema.js'

export type Raw = Record<string, any>
export const string = (value: unknown, max = 255): string => typeof value === 'string' ? value.slice(0, max) : ''
export const object = (value: unknown): Raw => value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : {}

export function rawOf(session: Session): Raw {
  const raw = object((session as any).webridge)
  return { ...object(raw.body), ...raw }
}

export function scopeOf(session: Session): Scope | undefined {
  const accountId = string(rawOf(session).accountId || (session.bot as any).deviceAccountId)
  if (session.platform !== 'webridge' || !accountId || !session.channelId) return
  return { platform: session.platform, accountId, channelId: session.channelId }
}

export function occurredAt(raw: Raw, fallback: Date): Date {
  const value = Number(raw.create_time)
  const ms = value > 1e12 ? value : value * 1000
  return Number.isFinite(ms) && ms > 0 && ms <= 8.64e15 ? new Date(ms) : fallback
}

// 只保存归档需要的媒体描述；不整包保存原始帧中的凭据、密钥和未知扩展。
const META_KEYS = [
  'msg_type', 'msg_subtype', 'raw_message_type', 'image_url', 'thumb_url', 'video_url',
  'voice_url', 'file_url', 'file_name', 'file_size', 'duration', 'md5', 'title', 'description',
  'url', 'at_user_list', 'at_all', 'is_at', 'member_nick_name', 'room_nick_name',
  'old_room_nick_name', 'new_room_nick_name', 'inviter_id', 'inviter_wxid',
  'app_msg_type', 'app_msg_title', 'app_msg_url', 'quote_from_user', 'quote_chat_user',
  'quote_display_name', 'quote_msg_type', 'quote_create_time',
] as const

function safeUrl(value: string): string {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    url.username = ''; url.password = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/key|token|auth|secret|sign|ticket/i.test(key)) url.searchParams.delete(key)
    }
    return url.toString()
  } catch { return '' }
}

export function metadata(raw: Raw): Raw {
  const result: Raw = {}
  for (const key of META_KEYS) {
    const value = raw[key]
    if (typeof value === 'string') result[key] = /url$/.test(key) ? safeUrl(value.slice(0, 4096)) : value.slice(0, 1024)
    else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) result[key] = value
    else if (key === 'at_user_list' && Array.isArray(value)) result[key] = value.slice(0, 1000).map(x => string(x))
  }
  return result
}

export function recordId(scope: Scope, kind: string, raw: Raw): string {
  // 微信消息 ID 可能是数字类型；全程字符串化，避免额外数值运算丢精度。
  const stable = raw.message_id ? ['message', String(raw.message_id)]
    : raw.event_id ? ['event', String(raw.event_id)]
    : ['fallback', raw.create_time ?? '', raw.sender_id ?? raw.member_id ?? '', raw.content ?? '', raw.old_room_nick_name ?? '', raw.new_room_nick_name ?? '']
  return createHash('sha256').update(JSON.stringify([scope.platform, scope.accountId, scope.channelId, kind, ...stable])).digest('hex')
}

export function messageRow(session: Session, maxContentLength: number, receivedAt = new Date()): MessageRow | undefined {
  const scope = scopeOf(session), raw = rawOf(session)
  if (!scope || raw.event_name !== 'message') return
  const original = typeof raw.content === 'string' ? raw.content : string(raw.content_xml, 2_000_000)
  // 媒体 XML 中的解密密钥不属于聊天正文，归档时移除其值。
  const source = original.replace(/\b(aeskey|cdnthumbaeskey)\s*=\s*(["'])[^"']*\2/gi, '$1="[redacted]"')
    .replace(/<(aeskey|cdnthumbaeskey)>[\s\S]*?<\/\1>/gi, '<$1>[redacted]</$1>')
  const quote = /<refermsg>[\s\S]*?<svrid>([^<]+)<\/svrid>[\s\S]*?<\/refermsg>/i.exec(source)?.[1] ?? ''
  return {
    ...scope, id: recordId(scope, 'message', raw), messageId: String(raw.message_id ?? '').slice(0, 255),
    eventId: string(raw.event_id), selfId: session.selfId, senderId: string(raw.sender_id),
    senderName: string(raw.sender_nick_name || raw.sender_name || session.event.user?.name),
    direction: raw.sender_id === scope.accountId ? 'out' : 'in',
    type: string(raw.msg_type || 'unknown', 64), subtype: string(raw.msg_subtype, 64),
    content: source.slice(0, maxContentLength), quoteId: string(raw.quote_msg_id || raw.quote_message_id || quote),
    metadata: metadata(raw), occurredAt: occurredAt(raw, receivedAt), receivedAt,
    truncated: source.length > maxContentLength,
  }
}

export function eventRow(session: Session, receivedAt = new Date()): EventRow | undefined {
  const scope = scopeOf(session), raw = rawOf(session)
  if (!scope || !scope.channelId.endsWith('@chatroom') || !String(raw.event_name).startsWith('group_member_')) return
  const nicknameChange = raw.event_name === 'group_member_nickname_change'
  return {
    ...scope, id: recordId(scope, string(raw.event_name), raw), eventId: string(raw.event_id),
    type: string(raw.event_name, 64), userId: string(raw.member_id),
    oldName: nicknameChange ? string(raw.old_room_nick_name) : '',
    newName: nicknameChange ? string(raw.new_room_nick_name) : '',
    metadata: metadata(raw), occurredAt: occurredAt(raw, receivedAt), receivedAt,
  }
}
