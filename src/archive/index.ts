import { Schema, type Context, type Computed } from '@koishijs/core'
import { ArchiveService } from './store.js'
export * from './schema.js'
export { ArchiveService } from './store.js'

export interface Config {
  filter?: Computed<boolean>
  autoRefresh: boolean
  capacity: number
  groupInterval: number
  staleAfter: number
  maxContentLength: number
  writeCapacity: number
  retentionDays: number
}

export const Config: Schema<Config> = Schema.object({
  filter: Schema.any().default(true).description('Koishi 原生归档过滤表达式；不影响消息收发与通讯录查询。'),
  autoRefresh: Schema.boolean().default(true).description('收到群消息或成员变动时，按需刷新群资料和成员目录。'),
  capacity: Schema.number().min(1).max(4096).step(1).default(512).description('每个账号的目录刷新队列容量。'),
  groupInterval: Schema.number().min(1000).max(86400000).default(60000).role('ms').description('同群两次目录查询的最小间隔。'),
  staleAfter: Schema.number().min(60000).max(2592000000).default(21600000).role('ms').description('目录过期时间；过期后有新消息才刷新。'),
  maxContentLength: Schema.number().min(1000).max(1000000).step(1).default(100000).description('单条正文最多保存的字符数；超出会标记截断。'),
  writeCapacity: Schema.number().min(16).max(65536).step(1).default(4096).description('待写入任务上限；溢出会记录错误和丢弃计数。'),
  retentionDays: Schema.number().min(0).max(36500).step(1).default(0).description('消息与事件保留天数，0 表示长期保存；不清理群和成员资料。'),
})

export function installArchive(ctx: Context, config: Config) {
  const archive = new ArchiveService(ctx, config)
  ctx.command('归档', '微信聊天与通讯录归档', { authority: 3 })
  ctx.command('归档.状态', '查看归档写入和目录刷新状态', { authority: 3 })
    .action(({ session }) => {
      if (!session || !ctx.filter(session)) return
      const s = archive.status()
      return `归档待写入 ${s.pending}，成功 ${s.written}，失败 ${s.failed}，丢弃 ${s.dropped}；目录待刷新 ${s.refreshPending}，查询失败 ${s.refreshFailed}，队列拒绝 ${s.refreshRejected}。`
    })
  ctx.guild().command('归档.同步', '同步当前群资料与成员目录', { authority: 3 })
    .action(async ({ session }) => {
      if (!session || !ctx.filter(session)) return
      try { await archive.syncGroup(session!, true); return '本群资料与成员目录已同步。' }
      catch { return '群资料同步失败，请检查归档状态及设备连接。' }
    })
  ctx.command('归档.同步全部', '将当前账号范围内的群加入目录同步队列', { authority: 4 })
    .action(async ({ session }) => {
      if (!session || !ctx.filter(session)) return
      try { return `已记录 ${await archive.syncAll(session!)} 个范围内的群；成员目录后台刷新，进度请查看归档.状态。` }
      catch { return '全量目录同步失败，请检查设备连接。' }
    })
  return archive
}
