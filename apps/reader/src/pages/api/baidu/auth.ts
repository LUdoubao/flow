import { randomBytes } from 'crypto'

import type { NextApiRequest, NextApiResponse } from 'next'

import {
  createBaiduAuthorizationUrl,
  setBaiduState,
} from '@flow/reader/server/baidu'

/**
 * 为当前浏览器创建一次性百度 OAuth state 并返回授权地址。
 * @param _req 当前同源 API 请求
 * @param res 返回授权 URL 或配置错误
 */
export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  if (_req.method !== 'GET') return res.status(405).end()

  try {
    const state = randomBytes(32).toString('hex')
    setBaiduState(res, state)
    return res.status(200).json({ url: createBaiduAuthorizationUrl(state) })
  } catch (error) {
    return res.status(500).json({ error: getErrorMessage(error) })
  }
}

function getErrorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'Baidu authorization setup failed'
}
