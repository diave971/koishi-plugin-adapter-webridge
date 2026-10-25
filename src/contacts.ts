/**
 * 协议结构 → satori 结构的映射，全是纯函数。
 *
 * 设备的查询命令（`friends` / `friends_all` / `groups_all` / `room_members`）返回的
 * 数组元素**共用同一套「联系人摘要」结构**（协议文档 14.4），所以只需要一份映射，
 * 再由四个出口函数投影成 satori 的 `User` / `Guild` / `GuildMember` / `Friend`。
 *
 * 取不到的名称字段在这里收敛成 `undefined` 而不是空串 —— satori 消费方（控制台、
 * 各中间件）普遍用 `??` 兜底，给空串会让它们以为「有名字，只是空的」，反而显示空白。
 */

import type { Universal } from '@satorijs/core'

import type { ContactSummary, RoomMembersResult } from './types.js'

/** 空串一律收敛成 `undefined`：空串在 satori 里是「有值但为空」，语义不同。 */
function orUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/**
 * 取联系人的 ID（wxid / 群 ID）。
 *
 * **缺失时直接抛**，绝不降级成空串：空串是个「看起来合法」的 id —— 它不会报错，
 * 却会悄悄污染所有以 id 为键的映射（koishi 自己的群成员表就是
 * `result[member.user.id] = ...`），事后很难查。协议里 `account_id` 是**恒有**字段，
 * 缺了就是设备或协议出了问题，应该当场暴露。
 *
 * 注意这和 `displayName()` 里「兜底成 wxid」不是一回事 —— 那是**显示名**降级，可以有；
 * id 不能降级。
 */
function requireId(contact: ContactSummary): string {
  const id = typeof contact?.account_id === 'string' ? contact.account_id.trim() : ''
  if (!id) throw new Error(`联系人缺少 account_id，无法构造 satori 对象：${JSON.stringify(contact)}`)
  return id
}

/**
 * 「联系人摘要」里的显示名。
 *
 * `display_name` 是设备给的「优先备注名、其次昵称」（协议文档 14.4），
 * 正好是微信聊天界面里显示的那个名字，所以它就是 satori 的 `name`。
 * 真机上有过整个字段缺失的情况，所以逐级兜底到 wxid —— 宁可显示得一串 ID，
 * 也不要给 satori 一个 `undefined` 让消息看着没有发送者。
 */
function displayName(contact: ContactSummary): string {
  const id = String(contact?.account_id ?? '')
  return orUndefined(contact?.display_name) ?? orUndefined(contact?.nick_name) ?? id
}

/** 联系人摘要 → satori `User`。 */
export function contactToUser(contact: ContactSummary): Universal.User {
  return {
    id: requireId(contact),
    name: displayName(contact),
    // `nick` 在 satori 里是昵称，对应微信的原始昵称（备注名已经进 `name` 了）。
    nick: orUndefined(contact?.nick_name),
    avatar: orUndefined(contact?.avatar_url),
  }
}

/**
 * 联系人摘要 → satori `Guild`。
 *
 * 群聊场景下 `account_id` 就是群 ID（形如 `xxx@chatroom`），`avatar_url` 是群头像。
 */
export function contactToGuild(contact: ContactSummary): Universal.Guild {
  return {
    id: requireId(contact),
    name: displayName(contact),
    avatar: orUndefined(contact?.avatar_url),
  }
}

/** satori 的 `GuildMember.title` 是头衔，微信侧对应的就是这两个身份。 */
const TITLE_OWNER = '群主'
const TITLE_ADMIN = '管理员'

/**
 * 联系人摘要 → satori `GuildMember`。
 *
 * `is_owner` / `is_admin` **取不到时字段整个不在**（协议文档明确写了不是给 `false`），
 * 所以用真值判断而不是 `=== true`；两者都没有就不设 `title`。
 */
export function contactToGuildMember(contact: ContactSummary): Universal.GuildMember {
  const member: Universal.GuildMember = {
    user: contactToUser(contact),
    nick: orUndefined(contact?.room_nick_name) ?? orUndefined(contact?.nick_name),
    avatar: orUndefined(contact?.avatar_url),
  }
  if (contact?.is_owner) member.title = TITLE_OWNER
  else if (contact?.is_admin) member.title = TITLE_ADMIN
  return member
}

/** 联系人摘要 → satori `Friend`。备注名放 `nick`，和 satori 的语义一致。 */
export function contactToFriend(contact: ContactSummary): Universal.Friend {
  return {
    user: contactToUser(contact),
    nick: orUndefined(contact?.remark),
  }
}

/**
 * `room_members` 的返回 → satori `Guild`。
 *
 * 这条路径专门用于「已知群 ID、只想拿群资料」的场合：`groups_all` 要拉全表，
 * 而 `room_members` 直接就带 `room_name` / `room_remark`。
 *
 * 名字优先取 `room_remark`（自己给群设的备注，微信界面上显示的就是它），
 * 其次是 `room_name`。群头像这条命令不给。
 */
export function roomToGuild(room: RoomMembersResult, fallbackId: string): Universal.Guild {
  return {
    id: orUndefined(room?.room_id) ?? fallbackId,
    name: orUndefined(room?.room_remark) ?? orUndefined(room?.room_name),
  }
}

/**
 * 把 satori 的 `next` 游标解析成 `friends` 命令要的 `offset`。
 *
 * 微信侧只给了 `limit` / `offset` 这种朴素分页，没有不透明游标，所以我们直接拿
 * 偏移量当游标（`'100'` 之类）—— 它对本适配器生成的 `next` 是自洽的，不承诺能
 * 接受别的来源的游标值。非法值一律当第一页。
 */
export function parseOffset(next?: string): number {
  const value = Number(next)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}
