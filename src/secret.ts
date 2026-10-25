/**
 * 路径密钥的首次生成与持久化。
 *
 * 协议没有 token 机制，凭据只能放在 WebSocket 路径里。用户没配 secret 时，
 * 插件首次启动生成一个随机值并写进实例的 `data/` 目录，之后重启沿用同一个值，
 * 手机里保存的地址才不会失效。
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 路径密钥允许的字符集（与 bot.ts 的校验保持一致，但这里不允许空串）。 */
const SECRET_PATTERN = /^[A-Za-z0-9_-]+$/

/** 生成一个 32 字符的随机路径密钥（base64url，天然只含 [A-Za-z0-9_-]）。 */
export function generateSecret(): string {
  return randomBytes(24).toString('base64url')
}

export interface SecretResult {
  secret: string
  /** true 表示这次是新生成的（不是配置里带的，也不是从文件里读到的）。 */
  generated: boolean
  /** secret 的来源：配置 / 之前生成的文件 / 本次生成。 */
  source: 'config' | 'file' | 'generated'
  /** 生成成功但写盘失败时的说明；调用方应打 warn。 */
  warning?: string
}

/**
 * 读取或创建路径密钥。
 *
 * 优先级：
 * 1. 配置里的 `secret`（非空）——用户显式配置的最高优先；
 * 2. `file` 里保存的 secret；
 * 3. 都没有时生成一个，并原子写入 `file`。
 *
 * 文件内容是 `{ "secret": "..." }`。读到坏文件不会让插件启动失败，而是重新生成。
 */
export function loadOrCreateSecret(file: string, configured: string): SecretResult {
  const value = (configured || '').trim()
  if (value) return { secret: value, generated: false, source: 'config' }

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed?.secret === 'string' && SECRET_PATTERN.test(parsed.secret)) {
      return { secret: parsed.secret, generated: false, source: 'file' }
    }
  } catch {
    // 文件不存在、不是 JSON、或读不了：都当作“没有”，下面重新生成。
  }

  const secret = generateSecret()
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify({ secret }, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
    return { secret, generated: true, source: 'generated' }
  } catch (error: any) {
    return {
      secret,
      generated: true,
      source: 'generated',
      warning: `无法写入 secret 文件 ${file}：${error?.message ?? error}`,
    }
  }
}
