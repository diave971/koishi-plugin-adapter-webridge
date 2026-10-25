/**
 * WeBridge 服务端 WebSocket 协议的帧类型定义。
 *
 * 字段名一律保持协议原文的 snake_case —— 这些类型描述的是**网线上**的结构，
 * 不跟着 TS 的命名习惯走，免得写代码时把 `event_id` 记成 `eventId` 发出去。
 *
 * 协议来源：WeBridge 插件作者提供的《服务端 WebSocket 协议说明》（v0.8.79）。
 */

/** `hello.state` —— 注意 WebSocket 模式下只有这 4 个字段（长轮询模式有 20 个）。 */
export interface WebridgeState {
  is_logged_in: boolean
  account_id: string
  auth_authorized: boolean
  plugin_enabled: boolean
}

/**
 * 每个请求都会带的身份与版本字段。
 *
 * `device_id` 首次启动生成后持久化（重启不变），适合做设备主键；
 * `session_id` 每次插件进程启动重新生成，只适合做本次连接关联键。
 */
export interface WebridgeCommon {
  device_id: string
  session_id: string
  account_id: string
  runtime_version: string
  build_marker: string
  ts_ms: number
}

/** 插件 → 服务端：握手。必须在 10 秒内回 `hello_ack`。 */
export interface HelloFrame extends WebridgeCommon {
  type: 'hello'
  capabilities: string[]
  state: WebridgeState
}

/**
 * `event` 帧的 body。
 *
 * 大部分字段都是可选的 —— 协议里说同一字段在不同事件类型下可能整个不存在，
 * 而不是给个空值。别用 `!` 断言，一律走可选链 + 兜底。
 */
export interface EventBody {
  message_id?: string
  msg_type?: string
  raw_message_type?: number
  msg_subtype?: string
  chat_id?: string
  room_id?: string
  sender_id?: string
  is_group?: boolean
  is_at?: boolean
  at_all?: boolean
  at_user_list?: string[]
  create_time?: number
  content?: string
  // content 能被识别为 XML 时出现
  content_xml?: string
  /** XML 之前的非空文本前缀。真机引用消息里是 `"<对方 wxid>:"`。 */
  content_prefix?: string
  // App 类消息（msg_type === 'app'）的细分。引用是 app_msg_type=57 / msg_subtype='quote'
  app_msg_type?: number
  app_msg_title?: string
  app_msg_url?: string
  voice_url?: string
  voice_aes_key?: string
  voice_md5?: string
  voice_data_length?: number
  voice_length_ms?: number
  emoji_cdn_url?: string
  emoji_encrypt_url?: string
  emoji_aes_key?: string
  emoji_md5?: string
  emoji_length?: number
  // 部分设备可能提供；没有这些字段时，从媒体 XML 读取引用，不假定一定存在。
  video_url?: string
  video_aes_key?: string
  video_md5?: string
  video_length?: number
  file_url?: string
  file_aes_key?: string
  file_md5?: string
  file_name?: string
  file_size?: number
  // 被引用时出现（真机实测只在 msg_subtype === 'quote' 时给出）
  quote_msg_id?: string
  quote_from_user?: string
  quote_chat_user?: string
  quote_display_name?: string
  quote_content?: string
  quote_msg_type?: number
  quote_create_time?: number
  // 群成员事件
  member_id?: string
  old_room_nick_name?: string
  new_room_nick_name?: string
  // 红包 / 转账 / 好友申请
  red_packet_id?: string
  transfer_id?: string
  encrypt_username?: string
  ticket?: string
  [key: string]: unknown
}

/**
 * 插件 → 服务端：事件上报。服务端不需要回响应。
 *
 * `event_id` **可能整个字段缺失**（拼不出关键业务 ID 时会被省略），
 * 所以去重时必须准备兜底组合键。它是不透明的，**不要解析它**。
 */
export interface EventFrame extends WebridgeCommon {
  type: 'event'
  event_name: string
  event_id?: string
  captured_at_ms: number
  enqueued_at_ms?: number
  body: EventBody
}

/** 插件 → 服务端：命令执行结果。 */
export interface CommandResultFrame extends WebridgeCommon {
  type: 'command_result'
  request_id: string
  command_name: string
  ok: boolean
  /** 命令**执行**耗时，不含网络往返。 */
  duration_ms?: number
  /** 恒为对象；无内容时是 `{}`。失败时也可能带诊断信息。 */
  result?: Record<string, unknown>
  /** 失败原因；成功时是**空串**，不是缺失。 */
  error?: string
}

/** 插件 → 服务端：应用层心跳响应（我们不发 `ping`，但解析时要认这个 type）。 */
export interface PongFrame {
  type: 'pong'
  ts_ms: number
}

/** 服务端 → 插件：握手确认。 */
export interface HelloAckFrame {
  type: 'hello_ack'
  server_version?: string
}

/** 服务端 → 插件：命令下发。 */
export interface CommandFrame {
  type: 'command'
  request_id: string
  command_name: string
  args: Record<string, unknown>
}

/** 从网线上收到的任意帧。 */
export type InboundFrame =
  | HelloFrame
  | EventFrame
  | CommandResultFrame
  | PongFrame
  | { type: string; [key: string]: unknown }

// ---------------------------------------------------------------------------
// 命令返回里的数据结构（协议文档 14.4 「查询结果结构」）
// ---------------------------------------------------------------------------

/**
 * 联系人摘要 —— `friends` / `friends_all` / `groups_all` / `room_members`
 * 的数组元素**共用同一套结构**。
 *
 * 恒有字段按文档标注；`is_owner` / `is_admin` / `is_self` **取不到时会被整个省略**，
 * 不是给 `false`（文档明确写了），所以是可选的。
 */
export interface ContactSummary {
  /** wxid；群聊场景下就是群 ID。 */
  account_id: string
  /** 展示名：优先备注名，其次昵称。 */
  display_name: string
  /** 备注名；无则空串。 */
  remark: string
  /** 微信号；未设置则空串。 */
  alias: string
  /** 微信昵称。 */
  nick_name: string
  /** 群成员快照中的群昵称；空串表示未设置。 */
  room_nick_name?: string
  /** 头像地址；取不到则空串。 */
  avatar_url: string
  /** `0` 未知 / `1` 男 / `2` 女。 */
  sex: number
  province: string
  city: string
  signature: string
  /** 好友添加时间，Unix 秒；未知为 null。仅 friends/friends_all 提供。 */
  add_time?: number | null
  /** 北京时间格式的添加时间；未知为 null。 */
  add_time_text?: string | null
  is_starred?: boolean
  is_blacklisted?: boolean
  /** 好友查询只读取缓存，不触发支付姓名查询。 */
  pay_name_last_char?: string
  pay_name_status?: 'not_queried' | 'querying' | 'ok' | 'unavailable' | 'failed'
  /** 是否在本地通讯录找到。 */
  contact_found: boolean
  /** 仅群成员场景。 */
  is_owner?: boolean
  /** 仅群成员场景。 */
  is_admin?: boolean
  /** 仅群成员场景。 */
  is_self?: boolean
  [key: string]: unknown
}

/** `groups_all` 的返回。无分页字段，一次给全。 */
export interface GroupsAllResult {
  keyword: string
  total: number
  items: ContactSummary[]
}

/**
 * `friends_all` 的返回。
 *
 * `items` 只含过滤后的普通好友；`total`、`friend_count` 与数组长度一致。
 * 其余分类仅提供计数，不混入好友数组（2026-10-23 作者文档）。
 */
export interface FriendsAllResult {
  keyword: string
  total: number
  friend_count: number
  official_account_count: number
  work_account_count: number
  system_account_count: number
  chatroom_count: number
  stranger_count: number
  cached_contact_count: number
  items: ContactSummary[]
}

/** `friends` 的返回。这个才带分页。 */
export interface FriendsResult {
  keyword: string
  limit: number
  offset: number
  total: number
  has_more: boolean
  items: ContactSummary[]
}

/** `room_members` 的返回。 */
export interface RoomMembersResult {
  room_id: string
  room_name: string
  room_remark: string
  current_user: string
  owner_user_name: string
  admin_count: number
  admin_user_names: string[]
  admin_members: ContactSummary[]
  self_is_owner: boolean
  self_is_admin: boolean
  member_count: number
  members: ContactSummary[]
}

/** `get_group_notice` 的返回。读的是**本机缓存**，不触发下载。 */
export interface GroupNoticeResult {
  room_id: string
  /** 本地没读到公告项时为 `false` —— 这**不能**证明群里没有公告。 */
  cached_notice_found: boolean
  summary: string | null
  html: string | null
  html_cached: boolean
}

/** `account_status` 的返回。 */
export interface AccountStatusResult {
  is_logged_in: boolean
  account_id: string
  user_name: string
  display_name: string
  remark: string
  alias: string
  nick_name: string
  avatar_url: string
  sex: number
  province: string
  city: string
  signature: string
  mobile: string
  country: string
  email: string
  has_profile_data: boolean
  wechat_version: string
}

/** `device_status` 的返回。 */
export interface DeviceStatusResult {
  ok: boolean
  ts_ms: number
  version: string
  build_marker: string
  /** 0.8.79 起才有。机型是 `iPhone14,3` 这类标识符，插件**不做商名映射**。 */
  device?: { ios_version: string; device_model: string }
  process_memory?: Record<string, number>
  system_memory?: Record<string, number>
  battery?: { percent: number; state: string }
  power?: Record<string, unknown>
  thermal?: Record<string, unknown>
  application?: Record<string, unknown>
  [key: string]: unknown
}
