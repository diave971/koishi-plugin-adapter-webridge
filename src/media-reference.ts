import { h } from '@satorijs/core'
import type { EventBody } from './types.js'

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''

/** 只读取指定媒体节点，拒绝 DTD，不解析引用/合并转发内的另一条消息。 */
function xmlNode(body: EventBody, tag: string): string {
  const xml = text(body.content_xml) || text(body.content)
  if (xml.length > 256 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)) return ''
  const start = xml.search(/<(?:msg|appmsg|appattach|emoji|voicemsg|videomsg)\b/i)
  if (start < 0) return ''
  try {
    const root = h.parse(xml.slice(start).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, value) => h.escape(value)))
      .find(item => item.type !== 'text')
    if (!root) return ''
    if (root.type === tag) return root.toString()
    if (root.type === 'msg' || root.type === 'appmsg' && tag === 'appattach') {
      return root.children.find(item => item.type === tag)?.toString() ?? ''
    }
  } catch { /* 畸形 XML 不产生资源引用。 */ }
  return ''
}

function tagText(node: string, tag: string): string {
  const raw = node.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1]?.trim() ?? ''
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(raw)
  return cdata ? cdata[1].trim() : /[<>]/.test(raw) ? '' : h.unescape(raw).trim()
}

export function isForwardedEmoji(body: EventBody): boolean {
  if (body.msg_type !== 'app' || Number(body.app_msg_type) !== 8 && body.msg_subtype !== 'upload') return false
  const attach = xmlNode({ content: xmlNode(body, 'appmsg') }, 'appattach')
  return /^[a-f0-9]{32}$/i.test(tagText(attach, 'emoticonmd5'))
}
