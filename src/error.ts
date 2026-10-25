import type { CommandResultFrame } from './types.js'

/** 保留失败和结果未知时的诊断数据，供调用方查询原任务；错误文本不展开密钥或 XML。 */
export class WebridgeCommandError extends Error {
  readonly code: string
  readonly result: Record<string, unknown>
  readonly requestId: string
  constructor(readonly command: string, readonly frame: CommandResultFrame) {
    const result = frame.result && typeof frame.result === 'object' && !Array.isArray(frame.result) ? frame.result : {}
    const code = String(result.error_code || frame.error || result.error || 'device-rejected')
    super(`${command} 失败：${code}${typeof result.message === 'string' ? `（${result.message}）` : ''}`)
    this.name = 'WebridgeCommandError'
    this.code = code
    this.result = result
    this.requestId = frame.request_id
  }
}

/** 网络失败只表示结果未知；保留关联 ID，供调用方核实原操作。 */
export class WebridgeTransportError extends Error {
  constructor(readonly code: string, readonly requestId: string, readonly command: string, message: string) {
    super(message)
    this.name = 'WebridgeTransportError'
  }
}
