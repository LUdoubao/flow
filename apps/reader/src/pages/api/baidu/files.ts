import type { NextApiRequest, NextApiResponse } from 'next'

import { getBaiduAccessToken, listBaiduEpubs } from '@flow/reader/server/baidu'

/**
 * 列出百度应用专属目录中的 EPUB 文件，不暴露 Access Token 给客户端。
 * @param req 同源请求，可用 start 查询参数继续分页
 * @param res 返回文件元数据或授权/API 错误状态
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== 'GET') return res.status(405).end()

  try {
    const accessToken = await getBaiduAccessToken(req, res)
    const start = Number(req.query.start || 0)
    if (!Number.isSafeInteger(start) || start < 0) {
      return res.status(400).json({ error: 'Invalid page offset' })
    }

    return res.status(200).json(await listBaiduEpubs(accessToken, start))
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Baidu file listing failed'
    const status =
      message.includes('not authorized') || message.includes('reauthorization')
        ? 401
        : 502
    return res.status(status).json({ error: message })
  }
}
