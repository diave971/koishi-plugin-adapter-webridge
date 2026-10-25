/**
 * 两个测试文件共用的夹具。
 *
 * 单独放一个文件是为了避免 e2e 与单测各写一份「联系人摘要」——
 * 一旦协议字段有变，两份会悄悄分叉。
 */

/**
 * 协议文档 14.4 的「联系人摘要」。
 *
 * `friends` / `friends_all` / `groups_all` / `room_members` 的数组元素共用这套字段，
 * 所以用同一个工厂造数据，缺省值就是「一个没有任何备注的普通联系人」。
 */
export function contact(over: Record<string, any> = {}) {
  return {
    account_id: 'wxid_x',
    display_name: '',
    remark: '',
    alias: '',
    nick_name: '',
    avatar_url: '',
    sex: 0,
    province: '',
    city: '',
    signature: '',
    contact_found: true,
    ...over,
  }
}
