import type { InboundMediaContent } from './media.js'

export type MessageMediaKind = 'image' | 'voice' | 'video' | 'file' | 'emoji'
export const DEFAULT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024

export class MediaError extends Error {
  constructor(readonly reason: string) { super(reason) }
}

/** 使用文件头，不信任上传方声明的 MIME。 */
export function imageMime(bytes: Buffer): string | undefined {
  if (bytes.length < 12) return
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.toString('ascii', 4, 8) === 'ftyp') {
    const brand = bytes.toString('ascii', 8, 12)
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1'].includes(brand)) return 'image/heic'
    if (['avif', 'avis'].includes(brand)) return 'image/avif'
  }
}

export function videoMime(bytes: Buffer): string | undefined {
  if (bytes.length < 12 || imageMime(bytes)) return
  if (bytes.toString('ascii', 4, 8) === 'ftyp') return bytes.toString('ascii', 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4'
  if (bytes.readUInt32BE(0) === 0x1a45dfa3) return 'video/webm'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'AVI ') return 'video/x-msvideo'
}

export function safeFilename(value: string): string {
  return (value.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || 'attachment.bin'
}

/** 新版手机只导出原始 SILK；适配器解码后再交给通用音频插件。 */
export async function prepareMedia(bytes: Buffer, kind: MessageMediaKind, max: number, filename?: string): Promise<InboundMediaContent> {
  if (!bytes.length || bytes.length > max) throw new MediaError('too-large')
  let mime = kind === 'image' || kind === 'emoji' ? imageMime(bytes)
    : kind === 'video' ? videoMime(bytes) : kind === 'file' ? 'application/octet-stream' : undefined
  let sourceMime: string | undefined, durationMs: number | undefined
  if (kind === 'voice') {
    if (!/^(?:\x02)?#!SILK_V3/.test(bytes.toString('ascii', 0, 16))) throw new MediaError('unsupported-voice-codec')
    const silk = await import('silk-wasm')
    try {
      durationMs = silk.getDuration(bytes)
      if (!durationMs || durationMs > 120_000) throw new MediaError('voice-duration-limit')
      if (durationMs * 48 + 44 > max) throw new MediaError('too-large')
      const decoded = await silk.decode(bytes, 24_000)
      if (!decoded.data.length) throw new MediaError('audio-decode-failed')
      const header = Buffer.alloc(44)
      header.write('RIFF'); header.writeUInt32LE(decoded.data.byteLength + 36, 4); header.write('WAVEfmt ', 8)
      header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
      header.writeUInt32LE(24_000, 24); header.writeUInt32LE(48_000, 28); header.writeUInt16LE(2, 32)
      header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(decoded.data.byteLength, 40)
      bytes = Buffer.concat([header, Buffer.from(decoded.data)])
      mime = 'audio/wav'
      sourceMime = 'audio/silk'
      filename = 'voice.wav'
    } catch (error) {
      throw error instanceof MediaError ? error : new MediaError('audio-decode-failed')
    }
  }
  if (!mime) throw new MediaError('unsupported-media-format')
  if (bytes.length > max) throw new MediaError('too-large')
  return { kind, status: 'ready', src: `data:${mime};base64,${bytes.toString('base64')}`, mime, size: bytes.length,
    ...(filename ? { filename: safeFilename(filename) } : {}), ...(sourceMime ? { sourceMime, durationMs } : {}) }
}
