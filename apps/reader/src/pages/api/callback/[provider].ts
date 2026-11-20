import type { NextApiRequest, NextApiResponse } from 'next'
import nookies from 'nookies'

import { mapToToken } from '@flow/reader/sync'

import { dbx } from '../utils'

/**
 * 处理 Dropbox OAuth 回调，将授权结果写入 Cookie 后返回阅读器页面。
 *
 * @param req Next.js API 请求，需包含 OAuth state 与 code
 * @param res Next.js API 响应，用于写 Cookie 或发送错误状态和重定向
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (
    typeof req.query.state !== 'string' ||
    typeof req.query.code !== 'string'
  ) {
    return res.status(400).end()
  }

  const state = JSON.parse(req.query.state)

  const response = await dbx.auth.getAccessTokenFromCode(
    state.redirectUri,
    req.query.code,
  )
  const result = response.result as any

  nookies.set({ res }, mapToToken['dropbox'], result.refresh_token, {
    maxAge: 365 * 24 * 60 * 60,
    secure: true,
    path: '/',
  })

  // https://stackoverflow.com/questions/4694089/sending-browser-cookies-during-a-302-redirect
  // 回调成功后回到带 basePath 的应用页面，避免落入同域其他站点。
  res.redirect(302, `${process.env.NEXT_PUBLIC_BASE_PATH}/success`)
}
