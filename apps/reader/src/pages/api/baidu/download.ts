import type { NextApiRequest, NextApiResponse } from 'next'

import {
  downloadBaiduEpub,
  getBaiduAccessToken,
} from '@flow/reader/server/baidu'

/**
 * 代理下载受授权目录限制的 EPUB；Access Token 和签名 dlink 不返回给前端。
 * @param req 同源请求，fsid 必须来自百度应用目录的文件列表
 * @param res EPUB 字节流或明确的 API/校验错误
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== 'GET') return res.status(405).end()
  if (typeof req.query.fsid !== 'string') {
    return res.status(400).json({ error: 'Missing Baidu file id' })
  }

  try {
    const accessToken = await getBaiduAccessToken(req, res)
    const { bytes, filename } = await downloadBaiduEpub(
      accessToken,
      req.query.fsid,
    )
    const encodedFilename = encodeURIComponent(filename).replace(
      /['()]/g,
      escape,
    )
    res.setHeader('Content-Type', 'application/epub+zip')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodedFilename}`,
    )
    res.setHeader('Content-Length', bytes.byteLength)
    res.setHeader('Cache-Control', 'private, no-store')
    return res.status(200).send(Buffer.from(bytes))
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Baidu EPUB download failed'
    // 只记录失败原因，不记录令牌、dlink 或文件内容，便于在容器日志里定位抓取失败。
    console.error('[baidu/download]', message)
    const status =
      message.includes('not authorized') || message.includes('reauthorization')
        ? 401
        : 502
    return res.status(status).json({ error: message })
  }
}
