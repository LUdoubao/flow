import { useCallback, useEffect, useState } from 'react'

import { useTranslation } from '../hooks'
import { OAUTH_SUCCESS_MESSAGE } from '../sync'

import { Button } from './Button'

const apiBasePath = process.env.NEXT_PUBLIC_BASE_PATH || ''

export interface BaiduEpub {
  fs_id: string
  server_filename: string
  size: number
}

interface BaiduFilesResponse {
  files: BaiduEpub[]
  nextStart: number | null
  error?: string
}

interface BaiduDriveProps {
  /** 把云端文件元数据交给统一书库网格，而不是在工具区另画文件列表。 */
  onFilesChange: (files: BaiduEpub[]) => void
}

/**
 * 百度网盘 EPUB 授权状态与目录清单控制器。
 *
 * <p>通过同源 API 使用百度 OAuth 凭据，只列出已授权的应用目录；将远端清单交由书库网格渲染。
 * Secret 与 Access Token 始终保留在服务端。</p>
 */
export const BaiduDrive: React.FC<BaiduDriveProps> = ({ onFilesChange }) => {
  const t = useTranslation()
  const [files, setFiles] = useState<BaiduEpub[]>([])
  const [authorized, setAuthorized] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()

  const loadFiles = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const response = await fetch(`${apiBasePath}/api/baidu/files`)
      const result = (await response.json()) as BaiduFilesResponse
      if (response.status === 401) {
        setAuthorized(false)
        setFiles([])
        onFilesChange([])
        return
      }
      if (!response.ok) throw new Error(result.error || t('baidu.error'))

      setAuthorized(true)
      setFiles(result.files || [])
      onFilesChange(result.files || [])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('baidu.error'))
    } finally {
      setLoading(false)
    }
  }, [onFilesChange, t])

  useEffect(() => {
    void loadFiles()
  }, [loadFiles])

  useEffect(() => {
    // OAuth callback posts this signal only to the opening Flow tab after setting HttpOnly cookies.
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      if (event.data === OAUTH_SUCCESS_MESSAGE) void loadFiles()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [loadFiles])

  const authorize = async () => {
    setError(undefined)
    // Open synchronously in the click handler so browser popup blockers allow OAuth navigation.
    const popup = window.open('about:blank', '_blank')
    if (!popup) {
      setError(t('baidu.popupBlocked'))
      return
    }

    try {
      const response = await fetch(`${apiBasePath}/api/baidu/auth`)
      const result = (await response.json()) as { url?: string; error?: string }
      if (!response.ok || !result.url) {
        throw new Error(result.error || t('baidu.error'))
      }
      popup.location.href = result.url
    } catch (cause) {
      popup.close()
      setError(cause instanceof Error ? cause.message : t('baidu.error'))
    }
  }

  const unauthorize = async () => {
    await fetch(`${apiBasePath}/api/baidu/logout`, { method: 'POST' })
    setAuthorized(false)
    setFiles([])
    onFilesChange([])
    setError(undefined)
  }

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      aria-label={t('baidu.title')}
    >
      {authorized ? (
        <>
          <Button
            variant="secondary"
            disabled={loading}
            onClick={() => void loadFiles()}
          >
            {t('baidu.refresh')}
          </Button>
          <Button variant="secondary" onClick={() => void unauthorize()}>
            {t('baidu.unauthorize')}
          </Button>
        </>
      ) : (
        <Button onClick={() => void authorize()}>{t('baidu.authorize')}</Button>
      )}
      {loading && (
        <span className="typescale-body-small" role="status">
          {t('baidu.loading')}
        </span>
      )}
      {files.length === 0 && authorized && !loading && (
        <span className="typescale-body-small">{t('baidu.empty')}</span>
      )}
      {error && (
        <span className="typescale-body-small text-red-600" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}
