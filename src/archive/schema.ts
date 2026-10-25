import type { Context } from '@koishijs/core'

export interface Scope {
  platform: string
  /** 设备握手报告的真实账号，不使用可以任意配置的 selfId。 */
  accountId: string
  channelId: string
}

export interface GroupRow extends Scope {
  name: string
  remark: string
  avatarUrl: string
  ownerId: string
  memberCount: number | null
  discoveredAt: Date
  updatedAt: Date
  syncedAt: Date | null
}

export interface MemberRow extends Scope {
  userId: string
  nickname: string
  roomNickname: string
  remark: string
  avatarUrl: string
  isOwner: boolean | null
  isAdmin: boolean | null
  membership: string
  membershipAt: Date | null
  joinedAt: Date | null
  leftAt: Date | null
  updatedAt: Date
  syncedAt: Date | null
}

export interface MessageRow extends Scope {
  id: string
  messageId: string
  eventId: string
  selfId: string
  senderId: string
  senderName: string
  direction: string
  type: string
  subtype: string
  content: string
  quoteId: string
  metadata: Record<string, unknown>
  occurredAt: Date
  receivedAt: Date
  truncated: boolean
}

export interface EventRow extends Scope {
  id: string
  eventId: string
  type: string
  userId: string
  oldName: string
  newName: string
  metadata: Record<string, unknown>
  occurredAt: Date
  receivedAt: Date
}

declare module '@koishijs/core' {
  interface Tables {
    'wechat.archive.group': GroupRow
    'wechat.archive.member': MemberRow
    'wechat.archive.message': MessageRow
    'wechat.archive.event': EventRow
  }
}

export function defineArchiveModels(ctx: Context) {
  const scope = { platform: 'string(32)', accountId: 'string(255)', channelId: 'string(255)' } as const
  ctx.model.extend('wechat.archive.group', {
    ...scope, name: 'string(255)', remark: 'string(255)', avatarUrl: 'text', ownerId: 'string(255)',
    memberCount: { type: 'unsigned', nullable: true, initial: null },
    discoveredAt: 'timestamp', updatedAt: 'timestamp', syncedAt: 'timestamp',
  }, { primary: ['platform', 'accountId', 'channelId'] })
  ctx.model.extend('wechat.archive.member', {
    ...scope, userId: 'string(255)', nickname: 'string(255)', roomNickname: 'string(255)',
    remark: 'string(255)', avatarUrl: 'text',
    isOwner: { type: 'boolean', nullable: true, initial: null },
    isAdmin: { type: 'boolean', nullable: true, initial: null },
    membership: 'string(16)', membershipAt: 'timestamp', joinedAt: 'timestamp', leftAt: 'timestamp',
    updatedAt: 'timestamp', syncedAt: 'timestamp',
  }, { primary: ['platform', 'accountId', 'channelId', 'userId'] })
  ctx.model.extend('wechat.archive.message', {
    ...scope, id: 'string(64)', messageId: 'string(255)', eventId: 'string(255)', selfId: 'string(255)',
    senderId: 'string(255)', senderName: 'string(255)', direction: 'string(16)', type: 'string(64)',
    subtype: 'string(64)', content: 'text', quoteId: 'string(255)', metadata: 'json',
    occurredAt: 'timestamp', receivedAt: 'timestamp', truncated: 'boolean',
  }, {
    primary: 'id', indexes: [
      { keys: { platform: 'asc', accountId: 'asc', channelId: 'asc', occurredAt: 'desc', id: 'desc' } },
      { keys: { receivedAt: 'asc' } },
    ],
  })
  ctx.model.extend('wechat.archive.event', {
    ...scope, id: 'string(64)', eventId: 'string(255)', type: 'string(64)', userId: 'string(255)',
    oldName: 'string(255)', newName: 'string(255)', metadata: 'json', occurredAt: 'timestamp', receivedAt: 'timestamp',
  }, {
    primary: 'id', indexes: [
      { keys: { platform: 'asc', accountId: 'asc', channelId: 'asc', occurredAt: 'desc' } },
      { keys: { receivedAt: 'asc' } },
    ],
  })
}
