import type { NextApiRequest, NextApiResponse } from 'next'

import { clearBaiduCookies } from '@flow/reader/server/baidu'

/**
 * 撤销当前浏览器保存的百度网盘授权凭据。
 * @param req 同源 POST 请求，避免跨站页面触发登出
 * @param res 删除 HttpOnly Token Cookie 并返回成功状态
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  clearBaiduCookies(res)
  return res.status(204).end()
}
