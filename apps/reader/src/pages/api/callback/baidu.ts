import type { NextApiRequest, NextApiResponse } from 'next'

import {
  consumeBaiduState,
  exchangeBaiduCode,
  setTokenCookies,
} from '@flow/reader/server/baidu'

/**
 * 处理百度 OAuth callback，校验一次性 state 后服务端交换授权码。
 * @param req 百度回调请求，需包含 code 和 state
 * @param res 写入 HttpOnly Token Cookie 并重定向到授权完成页面
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== 'GET') return res.status(405).end()
  if (typeof req.query.error === 'string') {
    return res.status(400).send('Baidu authorization was denied')
  }

  const { code, state } = req.query
  const expectedState = consumeBaiduState(req, res)
  if (
    typeof code !== 'string' ||
    typeof state !== 'string' ||
    !expectedState ||
    state !== expectedState
  ) {
    return res.status(400).send('Invalid or expired Baidu OAuth state')
  }

  try {
    // Token exchange stays server-side because the app SecretKey must never reach the browser.
    const token = await exchangeBaiduCode(code)
    setTokenCookies(res, token)
    return res.redirect(
      302,
      `${process.env.NEXT_PUBLIC_BASE_PATH || ''}/success`,
    )
  } catch {
    // Avoid exposing provider response bodies, which may contain OAuth diagnostics.
    return res
      .status(502)
      .send('Baidu authorization could not be completed; please retry')
  }
}
