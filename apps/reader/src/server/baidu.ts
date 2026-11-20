import type { NextApiRequest, NextApiResponse } from 'next'
import nookies from 'nookies'

/** 百度网盘 OAuth 与文件 API 使用的服务端 Cookie 名称。 */
const BAIDU_REFRESH_COOKIE = 'baidu-refresh-token'
const BAIDU_ACCESS_COOKIE = 'baidu-access-token'
const BAIDU_ACCESS_EXPIRY_COOKIE = 'baidu-access-expiry'
const BAIDU_STATE_COOKIE = 'baidu-oauth-state'
const TOKEN_URL = 'https://openapi.baidu.com/oauth/2.0/token'
const API_URL = 'https://pan.baidu.com/rest/2.0/xpan'
const APP_DIRECTORY = `/apps/${process.env.BAIDU_APP_NAME || '文件树索引助手'}`
const APP_ID = process.env.BAIDU_APP_ID || ''
const MAX_EPUB_BYTES = 50 * 1024 * 1024
const COOKIE_PATH = `${process.env.NEXT_PUBLIC_BASE_PATH || ''}/` || '/'

interface BaiduTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

interface BaiduFile {
  fs_id: string
  path: string
  server_filename: string
  size: number
  isdir: number
}

interface BaiduApiResponse<T> {
  errno: number
  show_msg?: string
  list?: T[]
}

/**
 * 生成百度 OAuth 授权地址；redirect_uri 必须与控制台登记值完全一致。
 * @param state 用于回调时校验请求来源的一次性随机值
 * @returns 百度 OAuth 授权页 URL
 */
export function createBaiduAuthorizationUrl(state: string) {
  const appKey = requireConfig('BAIDU_APP_KEY')
  const redirectUri = requireConfig('BAIDU_REDIRECT_URI')
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: appKey,
    redirect_uri: redirectUri,
    scope: 'basic,netdisk',
    state,
  })

  return `https://openapi.baidu.com/oauth/2.0/authorize?${query.toString()}`
}

/**
 * 用一次性 OAuth code 换取用户网盘令牌。
 * @param code 百度回调返回的一次性授权码
 * @returns Access Token、Refresh Token 及其有效期
 * @throws 百度拒绝授权、环境配置缺失或响应不完整时抛错
 */
export async function exchangeBaiduCode(code: string) {
  const query = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: requireConfig('BAIDU_APP_KEY'),
    client_secret: requireConfig('BAIDU_SECRET_KEY'),
    redirect_uri: requireConfig('BAIDU_REDIRECT_URI'),
  })
  const response = await fetch(`${TOKEN_URL}?${query.toString()}`)
  const token = (await response.json()) as BaiduTokenResponse

  if (
    !response.ok ||
    token.error ||
    !token.access_token ||
    !token.refresh_token
  ) {
    throw new Error(
      token.error_description ||
        token.error ||
        'Baidu OAuth token exchange failed',
    )
  }

  return token
}

/**
 * 读取有效 Access Token；过期时使用并轮换 Refresh Token，再写回 HttpOnly Cookie。
 * @param req 当前同源 API 请求
 * @param res 当前 API 响应，用于安全保存令牌
 * @returns 有效 Access Token
 * @throws 尚未授权或百度拒绝刷新时抛错
 */
export async function getBaiduAccessToken(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const cookies = nookies.get({ req })
  const accessToken = cookies[BAIDU_ACCESS_COOKIE]
  const expiresAt = Number(cookies[BAIDU_ACCESS_EXPIRY_COOKIE] || 0)

  // 提前 60 秒刷新，避免令牌在实际 API 请求过程中刚好过期。
  if (accessToken && expiresAt > Date.now() + 60_000) return accessToken

  const refreshToken = cookies[BAIDU_REFRESH_COOKIE]
  if (!refreshToken) throw new Error('Baidu account is not authorized')

  const query = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: requireConfig('BAIDU_APP_KEY'),
    client_secret: requireConfig('BAIDU_SECRET_KEY'),
  })
  const response = await fetch(`${TOKEN_URL}?${query.toString()}`)
  const token = (await response.json()) as BaiduTokenResponse

  if (
    !response.ok ||
    token.error ||
    !token.access_token ||
    !token.refresh_token
  ) {
    throw new Error(
      token.error_description ||
        token.error ||
        'Baidu token refresh failed; reauthorization is required',
    )
  }

  // 百度 Refresh Token 是单次轮换凭据；必须在成功刷新后立即写入新值。
  setTokenCookies(res, token)
  return token.access_token
}

/**
 * 保存百度 OAuth Token；HttpOnly 防止前端脚本读取长期凭据。
 * @param res 当前 API 响应
 * @param token 百度 Token 响应
 */
export function setTokenCookies(
  res: NextApiResponse,
  token: BaiduTokenResponse,
) {
  const maxAge = Math.max(0, token.expires_in || 0)
  const options = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: COOKIE_PATH,
  }

  nookies.set({ res }, BAIDU_ACCESS_COOKIE, token.access_token || '', {
    ...options,
    maxAge,
  })
  nookies.set(
    { res },
    BAIDU_ACCESS_EXPIRY_COOKIE,
    String(Date.now() + maxAge * 1000),
    { ...options, maxAge },
  )
  nookies.set({ res }, BAIDU_REFRESH_COOKIE, token.refresh_token || '', {
    ...options,
    maxAge: 10 * 365 * 24 * 60 * 60,
  })
}

/**
 * 清除 OAuth state Cookie，避免一次性 state 被重复使用。
 * @param req 当前 API 请求
 * @param res 当前 API 响应
 * @returns Cookie 中待校验的 state
 */
export function consumeBaiduState(req: NextApiRequest, res: NextApiResponse) {
  const state = nookies.get({ req })[BAIDU_STATE_COOKIE]
  nookies.destroy({ res }, BAIDU_STATE_COOKIE, {
    path: COOKIE_PATH,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  })
  return state
}

/**
 * 写入短期 OAuth state Cookie，限制 callback 只接受本浏览器发起的授权。
 * @param res 当前 API 响应
 * @param state 密码学随机 state
 */
export function setBaiduState(res: NextApiResponse, state: string) {
  nookies.set({ res }, BAIDU_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: COOKIE_PATH,
    maxAge: 10 * 60,
  })
}

/**
 * 列出应用专属目录中的 EPUB，不递归访问用户目录外的文件。
 * @param accessToken 当前用户授权的 Access Token
 * @param start 分页起点，百度 API 以 0 为起点
 * @returns EPUB 元数据和下一页起点
 */
export async function listBaiduEpubs(accessToken: string, start = 0) {
  const query = new URLSearchParams({
    method: 'list',
    access_token: accessToken,
    dir: APP_DIRECTORY,
    start: String(Math.max(0, Math.floor(start))),
    limit: '1000',
    order: 'name',
  })
  if (APP_ID) query.set('app_id', APP_ID)
  let response = await fetch(`${API_URL}/file?${query.toString()}`, {
    headers: { 'User-Agent': 'pan.baidu.com' },
  })
  let result = (await parseBaiduJson(
    response,
  )) as BaiduApiResponse<BaiduFile> & {
    list?: BaiduFile[]
  }

  // 新 OAuth 应用的专属目录可能尚未创建；只在平台明确返回 -9 时创建一次空应用目录并重试。
  if (response.ok && result.errno === -9) {
    await createBaiduAppDirectory(accessToken)
    response = await fetch(`${API_URL}/file?${query.toString()}`, {
      headers: { 'User-Agent': 'pan.baidu.com' },
    })
    result = (await parseBaiduJson(response)) as BaiduApiResponse<BaiduFile> & {
      list?: BaiduFile[]
    }
  }

  if (!response.ok || result.errno !== 0) {
    throw new Error(
      result.show_msg || `Baidu file list failed (${result.errno})`,
    )
  }

  const allFiles = result.list || []
  const epubFiles = allFiles.filter(
    (file) =>
      file.isdir === 0 &&
      file.path.startsWith(`${APP_DIRECTORY}/`) &&
      file.server_filename.toLowerCase().endsWith('.epub'),
  )

  return {
    files: epubFiles,
    nextStart: allFiles.length === 1000 ? start + allFiles.length : null,
  }
}

async function createBaiduAppDirectory(accessToken: string) {
  const query = new URLSearchParams({
    method: 'create',
    access_token: accessToken,
  })
  const body = new URLSearchParams({
    path: APP_DIRECTORY,
    isdir: '1',
    rtype: '0',
  })
  const response = await fetch(`${API_URL}/file?${query.toString()}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'pan.baidu.com',
    },
    body: body.toString(),
  })
  const result = (await parseBaiduJson(response)) as {
    errno: number
    show_msg?: string
  }

  // -8 means another request or an earlier attempt already created the directory; do not overwrite it.
  if (!response.ok || (result.errno !== 0 && result.errno !== -8)) {
    throw new Error(
      result.show_msg ||
        `Baidu app directory creation failed (${result.errno})`,
    )
  }
}

/**
 * 下载指定应用目录内且小于 50 MiB 的 EPUB。
 * @param accessToken 当前用户授权的 Access Token
 * @param fsId 百度列表返回的文件唯一标识
 * @returns EPUB 二进制及安全的文件名
 * @throws 文件不在授权应用目录、过大、过期或下载失败时抛错
 */
export async function downloadBaiduEpub(accessToken: string, fsId: string) {
  if (!/^\d+$/.test(fsId)) throw new Error('Invalid Baidu file id')

  // 百度 dlink 由文件 ID 获取，下载前再次确认返回路径仍属于本应用目录。
  const metadataQuery = new URLSearchParams({
    method: 'filemetas',
    access_token: accessToken,
    // fs_id 是 uint64；保留十进制文本，避免 JSON.stringify 将其舍入为错误 ID。
    fsids: `[${fsId}]`,
    dlink: '1',
  })
  const metadataResponse = await fetch(
    `https://pan.baidu.com/rest/2.0/xpan/multimedia?${metadataQuery.toString()}`,
    { headers: { 'User-Agent': 'pan.baidu.com' } },
  )
  const metadata = (await parseBaiduJson(metadataResponse)) as BaiduApiResponse<
    BaiduFile & { dlink?: string }
  >
  const file = metadata.list?.[0]

  if (
    !metadataResponse.ok ||
    metadata.errno !== 0 ||
    !file?.dlink ||
    !file.path.startsWith(`${APP_DIRECTORY}/`) ||
    !file.server_filename.toLowerCase().endsWith('.epub')
  ) {
    throw new Error(
      metadata.show_msg ||
        'Baidu EPUB metadata unavailable or outside the app directory',
    )
  }
  if (file.size > MAX_EPUB_BYTES) {
    throw new Error('This EPUB exceeds the 50 MiB browser download limit')
  }

  // dlink 必须是 HTTPS；拒绝异常 scheme，避免签名链接被当作任意协议请求。
  const downloadUrl = new URL(file.dlink)
  if (downloadUrl.protocol !== 'https:') {
    throw new Error('Baidu returned an insecure download URL')
  }

  // dlink 是短时签名地址；依文档附加令牌和指定 User-Agent 后由服务端取回。
  downloadUrl.searchParams.set('access_token', accessToken)
  const downloadResponse = await fetch(downloadUrl.toString(), {
    headers: { 'User-Agent': 'pan.baidu.com' },
  })
  if (!downloadResponse.ok) {
    throw new Error(`Baidu EPUB download failed (${downloadResponse.status})`)
  }
  const contentLength = Number(
    downloadResponse.headers.get('content-length') || 0,
  )
  if (contentLength > MAX_EPUB_BYTES) {
    throw new Error('This EPUB exceeds the 50 MiB browser download limit')
  }

  const bytes = await readResponseWithLimit(downloadResponse, MAX_EPUB_BYTES)
  const signature = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength))
  if (
    signature.length < 4 ||
    signature[0] !== 0x50 ||
    signature[1] !== 0x4b ||
    signature[2] !== 0x03 ||
    signature[3] !== 0x04
  ) {
    throw new Error('Baidu returned data that is not a valid EPUB/ZIP file')
  }

  return { bytes, filename: file.server_filename }
}

/** 删除全部百度网盘授权 Cookie。 */
export function clearBaiduCookies(res: NextApiResponse) {
  for (const name of [
    BAIDU_ACCESS_COOKIE,
    BAIDU_ACCESS_EXPIRY_COOKIE,
    BAIDU_REFRESH_COOKIE,
    BAIDU_STATE_COOKIE,
  ]) {
    nookies.destroy({ res }, name, {
      path: COOKIE_PATH,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
    })
  }
}

function requireConfig(
  name: 'BAIDU_APP_KEY' | 'BAIDU_SECRET_KEY' | 'BAIDU_REDIRECT_URI',
) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not configured on the server`)
  return value
}

async function readResponseWithLimit(response: Response, maxBytes: number) {
  if (!response.body)
    throw new Error('Baidu returned an empty download response')

  // Enforce the limit while reading; missing or inaccurate Content-Length must not exhaust server memory.
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  let finished = false
  while (!finished) {
    const result = await reader.read()
    if (result.done) {
      finished = true
      continue
    }
    const value = result.value
    totalBytes += value.byteLength
    if (totalBytes > maxBytes) {
      await reader.cancel()
      throw new Error('This EPUB exceeds the 50 MiB browser download limit')
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes.buffer
}

async function parseBaiduJson(response: Response) {
  // 百度 fs_id 是 uint64；先转成字符串，避免 JavaScript number 精度损失后下载错文件。
  const body = await response.text()
  const losslessBody = body.replace(/("fs_id"\s*:\s*)(\d+)/g, '$1"$2"')
  return JSON.parse(losslessBody) as unknown
}
