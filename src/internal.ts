/**
 * Webridge 的**内部接口**（挂到 `bot.internal`）。
 *
 * 为什么不直接把这些方法加在 Bot 类上 —— 官方指引（`guide/adapter/bot` 的
 * 「为什么不能直接在 Bot 类上添加方法？」）给了两条理由：
 *
 * 1. 插件拿到的是通用 `Bot` 类型，它无法确定背后是哪个适配器，想用原生能力本来
 *    就要做类型断言；
 * 2. **通用接口将来可能扩展出同名方法**（比如 satori 哪天加了 `getGuildNotice`），
 *    直接挂在 Bot 上就会撞名，而且是升级 Koishi 时才炸。
 *
 * 所以这里的划分是：
 *
 * - **satori `Methods` 里有的**（`getGuild*` / `getFriendList` / `getUser` /
 *   `kickGuildMember` / `deleteFriend` / `deleteMessage` / `getLogin`）留在 Bot 上，
 *   插件不必知道 WeBridge 的存在就能调用；
 * - **协议有、但 satori 没有对应概念的**（改群名、退群、读群公告、设备状态……）
 *   放在这里，走 `bot.internal.xxx()`。
 *
 * 和官方例子一样，`internal` 里的方法不直接下发命令，而是复用 `bot` 上的
 * `sendCommand` / `query` —— 那才是"怎么跟设备说话"的机制层。
 */

import { WebridgeNativeApi } from './native.js'
import {
  CMD_ACCEPT_FRIEND_REQUEST,
  CMD_ACCOUNT_STATUS,
  CMD_BRIDGE_STATUS,
  CMD_CLEAR_GENDER_REGION,
  CMD_DELETE_SESSION,
  CMD_DEVICE_STATUS,
  CMD_FORWARD_MESSAGE,
  CMD_GET_GROUP_NOTICE,
  CMD_INVITE_GROUP_MEMBER,
  CMD_MARK_SESSION_READ,
  CMD_PROFILE_GENDER,
  CMD_PROFILE_NICKNAME,
  CMD_PROFILE_PAT_SUFFIX,
  CMD_PROFILE_REGION,
  CMD_PROFILE_REGION_CODES,
  CMD_PROFILE_SIGNATURE,
  CMD_PROFILE_UPDATE,
  CMD_QUIT_GROUP,
  CMD_RECEIVE_RED_PACKET,
  CMD_RECEIVE_TRANSFER,
  CMD_RED_PACKET_DETAIL,
  CMD_RENAME_GROUP,
  CMD_SEND_FILE,
  CMD_SEND_IMAGE,
  CMD_SEND_LINK_CARD,
  CMD_SEND_LIVEPHOTO,
  CMD_SEND_MUSIC_CARD,
  CMD_SEND_PAT,
  CMD_SEND_SIGNAL,
  CMD_SEND_VIDEO,
  CMD_SEND_XML,
  CMD_SET_GROUP_NAME,
} from './protocol.js'
import type { InboundMediaContent } from './media.js'
import type { AccountStatusResult, DeviceStatusResult, GroupNoticeResult, RoomMembersResult } from './types.js'

export class WebridgeInternal extends WebridgeNativeApi {

  /** 完整目录快照，保留通用 Guild/GuildMember 无法表达的微信字段。 */
  async getGroupSnapshot(guildId: string, force = false): Promise<RoomMembersResult> {
    if (!guildId.endsWith('@chatroom')) throw new Error('需要有效的群 ID')
    return this.bot.directory.snapshot(guildId, force)
  }

  /**
   * 改**整个群聊的名称**（协议命令 `set_group_name`，0.8.79 新增）。
   *
   * ⚠️ 与 `setGuildSelfNickname` 严格区分：那个改的是「我在本群的昵称」。
   * 参数先在本地按协议校验，让调用方立刻看出是自己传的值不对，
   * 而不是等设备回一句 `error`。
   */
  async setGuildName(guildId: string, name: string): Promise<void> {
    const roomId = String(guildId ?? '').trim()
    if (!roomId.endsWith('@chatroom')) {
      throw new Error(`set_group_name 要求群 ID 以 @chatroom 结尾，收到 ${JSON.stringify(guildId)}`)
    }
    // 协议明确：群名不接受空串（能传空串清空的是「我在本群的昵称」）。
    const newName = String(name ?? '').trim()
    if (!newName) throw new Error('群名称不能为空')
    await this.bot.query<Record<string, unknown>>(CMD_SET_GROUP_NAME, { room_id: roomId, new_name: newName })
  }

  /**
   * 改**我在本群的群昵称**（协议命令 `rename_group`）。
   *
   * 传空串表示清空昵称 —— 这是协议允许的，与群名不同，所以不做非空校验。
   */
  async setGuildSelfNickname(guildId: string, name = ''): Promise<void> {
    await this.bot.query<Record<string, unknown>>(CMD_RENAME_GROUP, { room_id: guildId, new_name: String(name ?? '') })
  }

  /** 退出群聊（协议命令 `quit_group`）。参数名是 `id`，和设备其他命令不一致。 */
  async leaveGuild(guildId: string): Promise<void> {
    await this.bot.query<Record<string, unknown>>(CMD_QUIT_GROUP, { id: guildId })
  }

  /** 邀请某人入群（协议命令 `invite_group_member`）。 */
  async inviteGuildMember(guildId: string, userId: string): Promise<void> {
    await this.bot.query<Record<string, unknown>>(CMD_INVITE_GROUP_MEMBER, { room_id: guildId, wxid: userId })
  }

  /**
   * 读**本机缓存**的群公告（协议命令 `get_group_notice`，0.8.79 新增）。
   *
   * ⚠️ 原样透传协议结构，不做「有没有公告」的判断：缓存可能不存在或已过期，
   * `cached_notice_found` 为 `false` **不能**证明群里没有公告。
   */
  async getGuildNotice(guildId: string): Promise<GroupNoticeResult> {
    return this.bot.query<GroupNoticeResult>(CMD_GET_GROUP_NOTICE, { room_id: guildId })
  }

  /**
   * 把会话标记为已读（协议命令 `mark_session_read`）。
   *
   * `identifier` 可以是单个会话 ID、ID 数组，或 `'all'`（大小写不敏感，表示全部）。
   */
  async markSessionRead(identifier: string | string[]): Promise<void> {
    await this.bot.query<Record<string, unknown>>(CMD_MARK_SESSION_READ, { identifier })
  }

  /**
   * 手机端 WeBridge 设置里要填的完整 WebSocket 地址。
   *
   * 与启动日志里打印的是同一个值；`address` 改了之后也会跟着变。
   * 用户拿这个地址去手机里粘贴，不用自己拼主机 / 端口 / 路径 / secret。
   */
  getCallbackUrl(): string {
    return this.bot.callbackUrl()
  }

  /**
   * 当前登录账号的资料（协议命令 `account_status`）。
   *
   * 握手帧里**没有**昵称字段，所以「机器人叫什么」只能问这条。
   * `bot.getLogin()` 内部用的也是它。
   */
  async getAccountStatus(): Promise<AccountStatusResult> {
    return this.bot.query<AccountStatusResult>(CMD_ACCOUNT_STATUS)
  }

  /**
   * 设备运行状态（电量、内存、前后台等）。
   * `device.ios_version` / `device.device_model` 是 0.8.79 起才有的字段。
   */
  async getDeviceStatus(): Promise<DeviceStatusResult> {
    return this.bot.query<DeviceStatusResult>(CMD_DEVICE_STATUS)
  }

  /**
   * 插件的完整诊断快照。
   * 协议明确说「字段随内部状态变化，不要依赖其中任何字段做业务判断」，
   * 所以只做类型上的透传，不解读内容。
   */
  async getBridgeStatus(): Promise<Record<string, unknown>> {
    return this.bot.query<Record<string, unknown>>(CMD_BRIDGE_STATUS)
  }

  // ------------------------------------------------------------------
  // 好友申请（协议 14.2 / 15.7）
  // ------------------------------------------------------------------

  /**
   * 同意好友申请。
   *
   * 协议 15.7 明确要求：**同意前先校验 `encrypt_username` 和 `ticket` 是否都存在**，
   * 缺失时不要盲调。这里在本地就挡住，让调用方立刻看出是自己参数不对，
   * 而不是等设备回一个看不懂的失败。
   */
  async acceptFriendRequest(args: {
    encryptUsername: string
    ticket: string
    requestId?: string
    scene?: number
    sayContent?: string
  }): Promise<Record<string, unknown>> {
    const encryptUsername = String(args?.encryptUsername ?? '').trim()
    const ticket = String(args?.ticket ?? '').trim()
    if (!encryptUsername || !ticket) {
      throw new Error('accept_friend_request 需要 encrypt_username 与 ticket（协议 15.7）')
    }
    const payload: Record<string, unknown> = {
      encrypt_username: encryptUsername,
      ticket,
    }
    // 注意：这里的 request_id 是**好友申请的业务 ID**，不是命令信封那个 request_id
    // （协议 14.2 专门警告过这个重名陷阱）
    if (args.requestId) payload.request_id = String(args.requestId)
    if (args.scene !== undefined) payload.scene = args.scene
    if (args.sayContent) payload.say_content = String(args.sayContent)
    return this.bot.query(CMD_ACCEPT_FRIEND_REQUEST, payload)
  }

  // ------------------------------------------------------------------
  // 红包与转账（协议 14.2 / 15.4 / 15.5）
  // ------------------------------------------------------------------

  /** 领取红包。`red_packet_id` 就是事件里的同名字段，也是去重键。 */
  async receiveRedPacket(redPacketId: string): Promise<Record<string, unknown>> {
    const id = String(redPacketId ?? '').trim()
    if (!id) throw new Error('receive_red_packet 需要 red_packet_id')
    return this.bot.query(CMD_RECEIVE_RED_PACKET, { red_packet_id: id })
  }

  /** 查红包详情。 */
  async getRedPacketDetail(redPacketId: string): Promise<Record<string, unknown>> {
    const id = String(redPacketId ?? '').trim()
    if (!id) throw new Error('red_packet_detail 需要 red_packet_id')
    return this.bot.query(CMD_RED_PACKET_DETAIL, { red_packet_id: id })
  }

  /**
   * 确认收款。
   *
   * ⚠️ 成功判据（协议 14.2）：`ok == true` **且** `result.status == "confirm_invoked"`。
   * 本方法把这条判断做掉，失败直接抛 —— 调用方不需要自己记住这个约定。
   * **不要**拿 `callback_received == true` 当判据，协议明确否定了它。
   */
  async receiveTransfer(transferId: string, messageId: string): Promise<Record<string, unknown>> {
    const transfer = String(transferId ?? '').trim()
    const message = String(messageId ?? '').trim()
    if (!transfer || !message) {
      throw new Error('receive_transfer 需要 transfer_id 与 message_id')
    }
    const result = await this.bot.query<Record<string, unknown>>(CMD_RECEIVE_TRANSFER, {
      transfer_id: transfer,
      message_id: message,
    })
    if (String(result?.status ?? '') !== 'confirm_invoked') {
      throw new Error(
        `receive_transfer 未确认收款（status=${JSON.stringify(result?.status ?? null)}，期望 "confirm_invoked"）`,
      )
    }
    return result
  }

  // ------------------------------------------------------------------
  // 会话管理（协议 14.2）
  // ------------------------------------------------------------------

  /** 删除会话。`id` 是会话 ID（群 ID 或 wxid）。 */
  async deleteSession(id: string): Promise<Record<string, unknown>> {
    return this.bot.query(CMD_DELETE_SESSION, { id: String(id ?? '') })
  }

  // ------------------------------------------------------------------
  // 其他发送入口（satori 里没有对应元素类型，走 internal）
  // ------------------------------------------------------------------

  /**
   * 发送拍一拍（协议 14.2：`receiver` 必需，群聊要给 `room_id`）。
   *
   * ⚠️ satori 的元素模型里没有「拍一拍」，所以只能走这里。
   */
  async sendPat(receiver: string, roomId?: string): Promise<Record<string, unknown>> {
    const target = String(receiver ?? '').trim()
    if (!target) throw new Error('send_pat 需要 receiver')
    const args: Record<string, unknown> = { receiver: target }
    if (roomId) args.room_id = String(roomId)
    return this.bot.query(CMD_SEND_PAT, args)
  }

  /** 发送小信号（协议 14.2：只有 `receiver`）。 */
  async sendSignal(receiver: string): Promise<Record<string, unknown>> {
    const target = String(receiver ?? '').trim()
    if (!target) throw new Error('send_signal 需要 receiver')
    return this.bot.query(CMD_SEND_SIGNAL, { receiver: target })
  }

  /**
   * 发送原始 appmsg XML（协议 14.2：`receiver` / `xml` / `type`，可选 `forward`）。
   *
   * 适用于平台原生卡片等高级用法；返回受理结果不等于微信端展示成功。
   */
  async sendXml(
    receiver: string,
    xml: string,
    type: number,
    forward = false,
  ): Promise<Record<string, unknown>> {
    const target = String(receiver ?? '').trim()
    if (!target) throw new Error('send_xml 需要 receiver')
    if (!String(xml ?? '').trim()) throw new Error('send_xml 需要 xml')
    if (!Number.isFinite(Number(type))) throw new Error('send_xml 需要数字 type')
    return this.bot.query(CMD_SEND_XML, {
      receiver: target,
      xml: String(xml),
      type: Number(type),
      forward: Boolean(forward),
    })
  }

  /** 转发消息（协议 14.2：`receiver` + `message_id`）。 */
  async forwardMessage(receiver: string, messageId: string): Promise<Record<string, unknown>> {
    const target = String(receiver ?? '').trim()
    const message = String(messageId ?? '').trim()
    if (!target || !message) throw new Error('forward_message 需要 receiver 与 message_id')
    return this.bot.query(CMD_FORWARD_MESSAGE, { receiver: target, message_id: message })
  }

  /**
   * 发送链接卡片（协议 14.2：`receiver` / `title` / `url` 必需）。
   *
   * satori 的元素模型里没有「链接卡片」，硬造自定义段名对调用方不友好，
   * 所以放在 internal 上。真机未验收。
   */
  async sendLinkCard(
    receiver: string,
    card: { title: string; url: string; description?: string; thumbUrl?: string },
  ): Promise<Record<string, unknown>> {
    const target = String(receiver ?? '').trim()
    if (!target) throw new Error('send_link_card 需要 receiver')
    if (!String(card?.title ?? '').trim() || !String(card?.url ?? '').trim()) {
      throw new Error('send_link_card 需要 title 与 url')
    }
    const args: Record<string, unknown> = { receiver: target, title: card.title, url: card.url }
    if (card.description) args.description = card.description
    if (card.thumbUrl) args.thumb_url = card.thumbUrl
    return this.bot.query(CMD_SEND_LINK_CARD, args)
  }

  /**
   * 发送音乐卡片（协议 14.2：`receiver` / `title` 必需）。
   *
   * 协议里 URL 相关字段有好几个（`url` / `data_url` / `song_album_url`），
   * 这里原样透出，不做猜测性映射。真机未验收。
   */
  async sendMusicCard(
    receiver: string,
    card: {
      title: string
      desc?: string
      url?: string
      dataUrl?: string
      songAlbumUrl?: string
      songLyric?: string
      appId?: string
      appName?: string
    },
  ): Promise<Record<string, unknown>> {
    const target = String(receiver ?? '').trim()
    if (!target) throw new Error('send_music_card 需要 receiver')
    if (!String(card?.title ?? '').trim()) throw new Error('send_music_card 需要 title')
    const args: Record<string, unknown> = { receiver: target, title: card.title }
    if (card.desc) args.desc = card.desc
    if (card.url) args.url = card.url
    if (card.dataUrl) args.data_url = card.dataUrl
    if (card.songAlbumUrl) args.song_album_url = card.songAlbumUrl
    if (card.songLyric) args.song_lyric = card.songLyric
    if (card.appId) args.app_id = card.appId
    if (card.appName) args.app_name = card.appName
    return this.bot.query(CMD_SEND_MUSIC_CARD, args)
  }

  /**
   * 按**设备本地路径**发图片（协议 14.2：`receiver` + `image_path`）。
   *
   * ⚠️ 路径必须是**手机上的**路径，Koishi 侧拿不到。日常发图请用
   * `h('img', { src })` —— 适配器会走 `send_image` 的 URL 入口。
   * 这个方法只服务于「知道设备上确实有那个文件」的场景。
   */
  async sendImageByPath(receiver: string, imagePath: string): Promise<Record<string, unknown>> {
    return this.bot.query(CMD_SEND_IMAGE, {
      receiver: String(receiver ?? ''),
      image_path: String(imagePath ?? ''),
    })
  }

  /** 按**设备本地路径**发视频（协议 14.2：`receiver` + `source`）。 */
  async sendVideoByPath(receiver: string, source: string): Promise<Record<string, unknown>> {
    return this.bot.query(CMD_SEND_VIDEO, { receiver: String(receiver ?? ''), source: String(source ?? '') })
  }

  /** 按**设备本地路径**发文件（协议 14.2：`receiver` + `file_path`）。 */
  async sendFileByPath(receiver: string, filePath: string): Promise<Record<string, unknown>> {
    return this.bot.query(CMD_SEND_FILE, {
      receiver: String(receiver ?? ''),
      file_path: String(filePath ?? ''),
    })
  }

  /**
   * 发实况照片（协议 14.2：`receiver` + `video_path`，可选 `image_path` 等）。
   *
   * ⚠️ 设备上必须是**实况照片**。作者口径里其余参数都是可选的；
   * 带 `image_path` 的那版曾出现「设备全绿、微信端红色感叹号」，
   * 所以这里默认**只传必需参数**，额外字段由调用方显式给。
   */
  async sendLivePhoto(
    receiver: string,
    videoPath: string,
    options: { imagePath?: string; stillImageTimeMs?: number; preferredHevc?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {
      receiver: String(receiver ?? ''),
      video_path: String(videoPath ?? ''),
    }
    if (options.imagePath) args.image_path = options.imagePath
    if (options.stillImageTimeMs !== undefined) args.still_image_time_ms = options.stillImageTimeMs
    if (options.preferredHevc !== undefined) args.prefered_hevc = options.preferredHevc
    return this.bot.query(CMD_SEND_LIVEPHOTO, args)
  }

  // ------------------------------------------------------------------
  // 资料管理（协议 14.2）
  // ------------------------------------------------------------------

  /** 改账号昵称（`profile_nickname`）。 */
  async setProfileNickname(nickname: string): Promise<Record<string, unknown>> {
    return this.bot.query(CMD_PROFILE_NICKNAME, { nickname: String(nickname ?? '') })
  }

  /** 设置或清空性别（`profile_gender`）：0 未知 / 1 男 / 2 女。 */
  async setProfileGender(sex: number): Promise<Record<string, unknown>> {
    const value = Number(sex)
    if (![0, 1, 2].includes(value)) throw new Error('profile_gender 的 sex 只能是 0 / 1 / 2')
    return this.bot.query(CMD_PROFILE_GENDER, { sex: value })
  }

  /** 设置或清空地区（`profile_region`）：`region_code` 与 `region` 二选一。 */
  async setProfileRegion(value: { regionCode?: string; region?: string }): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {}
    if (value?.regionCode !== undefined) args.region_code = value.regionCode
    else if (value?.region) args.region = value.region
    else throw new Error('profile_region 需要 region_code 或 region')
    return this.bot.query(CMD_PROFILE_REGION, args)
  }

  /** 设置或清空签名（`profile_signature`）：空串表示清空。 */
  async setProfileSignature(signature: string): Promise<Record<string, unknown>> {
    return this.bot.query(CMD_PROFILE_SIGNATURE, { signature: String(signature ?? '') })
  }

  /** 设置或清空拍一拍后缀（`profile_pat_suffix`）：空串表示清空。 */
  async setProfilePatSuffix(suffix: string): Promise<Record<string, unknown>> {
    return this.bot.query(CMD_PROFILE_PAT_SUFFIX, { pat_suffix: String(suffix ?? '') })
  }

  /**
   * 批量设置性别 / 地区 / 签名（`profile_update`）：**至少给一项**。
   */
  async updateProfile(patch: {
    sex?: number
    regionCode?: string
    region?: string
    signature?: string
  }): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {}
    if (patch?.sex !== undefined) args.sex = Number(patch.sex)
    if (patch?.regionCode !== undefined) args.region_code = patch.regionCode
    if (patch?.region !== undefined) args.region = patch.region
    if (patch?.signature !== undefined) args.signature = patch.signature
    if (!Object.keys(args).length) {
      throw new Error('profile_update 至少要给 sex / region_code / region / signature 之一')
    }
    return this.bot.query(CMD_PROFILE_UPDATE, args)
  }

  /** 清除性别与地区（`clear_gender_region`），无参数。 */
  async clearGenderRegion(): Promise<Record<string, unknown>> {
    return this.bot.query(CMD_CLEAR_GENDER_REGION)
  }

  /**
   * 查询地区代码（`profile_region_codes`，只读）。
   *
   * 省略 `parentCode` 或传空串查国家。⚠️ 协议提醒：不要拼中文名称，
   * `name` 随微信语言变化；叶节点或不存在的父代码可能返回空列表。
   */
  async getRegionCodes(parentCode = ''): Promise<Record<string, unknown>> {
    return this.bot.query(CMD_PROFILE_REGION_CODES, parentCode ? { parent_code: parentCode } : {})
  }
}

/**
 * `session.webridge` 的类型：**帧里的原始字段 + `bot.internal` 的方法**。
 *
 * 两者的关系来自 satori 的实现（`@satorijs/core/src/session.ts` 的 `setInternal`）：
 *
 * ```js
 * setInternal(type, data) {
 *   this.event._type = type
 *   this.event._data = data
 *   const internal = Object.create(this.bot.internal)   // ← 原型指向 bot.internal
 *   defineProperty(this, type, Object.assign(internal, data))
 * }
 * ```
 *
 * 也就是说 `session.webridge` 的原型是 `bot.internal`，实例自己的属性是那一帧的
 * `body` —— 所以「原始字段」和「internal 的方法」在同一个对象上都能取到，
 * 类型上也必须交叉起来写，只写一半就会漏。
 *
 * 用索引签名是因为帧字段随设备版本变化（协议自己都说「不要依赖其中任何字段」），
 * 逐个列出既列不全、也会在设备升级后失准。
 */
export type WebridgeSessionInternal = WebridgeInternal & Record<string, any> & { media?: InboundMediaContent[] }

