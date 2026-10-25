/**
 * WeBridge 的 Adapter 层。
 *
 * 为什么要单独一个类：v4 的 `Bot.start()` 调的是 **`this.adapter?.connect(this)`**，
 * 而不是 `Bot.connect()`（见 `@satorijs/core/src/bot.ts`）。所以「起服务端」这件事
 * 只能挂在 `Adapter` 子类上，写在 Bot 里的 `connect()` 永远不会被调用。
 */

import { Adapter, type Context } from '@satorijs/core'
// 副作用导入：只为加载 `@cordisjs/plugin-server` 对 Context 的模块增强，
// 让 `ctx.server` 有类型。
import {} from '@koishijs/plugin-server'

import type { WebridgeBot } from './bot.js'

export class WebridgeServer<C extends Context = Context> extends Adapter<C, WebridgeBot<C>> {
  static inject = ['server']
  static reusable = true

  /**
   * 官方适配器全是这个套路（telegram 的 `HttpServer`、kook / discord / slack … 都一样）：
   * Bot 在**自己的构造函数**里 `ctx.plugin(XxxAdapter, this)` 把 bot 作为配置传进来，
   * Adapter 再把 bot 挂到自己身上 —— 而不是去调 `Adapter.fork()`。
   *
   * 走 `ctx.plugin` 意味着 Adapter 自己也活在插件系统里、有自己的 fork scope，
   * 加载与卸载交给 cordis 管。`Adapter.fork()` 只是「赋值 + 记进 bots + 注册一个
   * dispose 清理」，在 `@satorijs/core` 和全部官方适配器里**调用点为 0**，不是推荐入口。
   */
  constructor(ctx: C, bot: WebridgeBot<C>) {
    super(ctx)
    bot.adapter = this
  }

  async connect(bot: WebridgeBot<C>): Promise<void> {
    bot.setupRoute()
  }

  async disconnect(bot: WebridgeBot<C>): Promise<void> {
    bot.teardownRoute()
  }
}
