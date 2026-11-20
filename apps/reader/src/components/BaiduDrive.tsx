import { useCallback, useEffect, useState } from 'react'

import { handleFiles } from '../file'
import { useTranslation } from '../hooks'
import { reader } from '../models'
import { OAUTH_SUCCESS_MESSAGE } from '../sync'

import { Button } from './Button'

const apiBasePath = process.env.NEXT_PUBLIC_BASE_PATH || ''

interface BaiduEpub {
  fs_id: string
  server_filename: string
  size: number
}

interface BaiduFilesResponse {
  files: BaiduEpub[]
  nextStart: number | null
  error?: string
}

/**
 * 百度网盘 EPUB 浏览和导入组件。
 *
 * <p>通过同源 API 使用百度 OAuth 凭据，只列出已授权的应用目录；下载文件后复用
 * Flow 现有 File 导入与 IndexedDB 阅读流程，不将 Secret 或 Access Token 暴露给浏览器。</p>
 */
export const BaiduDrive: React.FC = () => {
  const t = useTranslation()
  const [files, setFiles] = useState<BaiduEpub[]>([])
  const [authorized, setAuthorized] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingFile, setLoadingFile] = useState<string>()
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
        return
      }
      if (!response.ok) throw new Error(result.error || t('baidu.error'))

      setAuthorized(true)
      setFiles(result.files || [])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('baidu.error'))
    } finally {
      setLoading(false)
    }
  }, [t])

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
    setError(undefined)
  }

  const openBook = async (book: BaiduEpub) => {
    setLoadingFile(String(book.fs_id))
    setError(undefined)
    try {
      const response = await fetch(
        `${apiBasePath}/api/baidu/download?fsid=${encodeURIComponent(
          book.fs_id,
        )}`,
      )
      if (!response.ok) {
        const result = (await response.json()) as { error?: string }
        throw new Error(result.error || t('baidu.error'))
      }

      // The existing reader expects a browser File and stores its bytes in IndexedDB.
      const file = new File([await response.blob()], book.server_filename, {
        type: 'application/epub+zip',
      })
      const imported = await handleFiles([file])
      imported.forEach((record) => reader.addTab(record))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('baidu.error'))
    } finally {
      setLoadingFile(undefined)
    }
  }

  return (
    <section
      className="rounded-lg border border-gray-200 p-3"
      aria-label={t('baidu.title')}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="typescale-title-medium">{t('baidu.title')}</h2>
          <p className="typescale-body-small text-on-surface-variant">
            {t('baidu.directory')}
          </p>
        </div>
        <div className="flex gap-2">
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
            <Button onClick={() => void authorize()}>
              {t('baidu.authorize')}
            </Button>
          )}
        </div>
      </div>

      {loading && <p role="status">{t('baidu.loading')}</p>}
      {error && (
        <p className="mt-2 text-red-600" role="alert">
          {error}
        </p>
      )}
      {authorized && !loading && files.length === 0 && (
        <p className="text-on-surface-variant mt-2">{t('baidu.empty')}</p>
      )}
      {files.length > 0 && (
        <ul className="mt-3 divide-y divide-gray-200">
          {files.map((file) => (
            <li
              key={file.fs_id}
              className="flex items-center justify-between gap-3 py-2"
            >
              <span className="truncate">{file.server_filename}</span>
              <Button
                variant="secondary"
                disabled={loadingFile === String(file.fs_id)}
                onClick={() => void openBook(file)}
              >
                {loadingFile === String(file.fs_id)
                  ? t('baidu.downloading')
                  : t('baidu.open')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
