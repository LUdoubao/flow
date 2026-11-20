import clsx from 'clsx'
import { useState } from 'react'

import { useTranslation } from '../hooks'

import type { BaiduEpub } from './BaiduDrive'
import { Button } from './Button'

interface BaiduBookTileProps {
  book: BaiduEpub
  loading?: boolean
  onOpen: (book: BaiduEpub) => Promise<void>
}

/**
 * 将尚未缓存的百度网盘 EPUB 呈现为书库统一网格磁贴。
 * 下载和 IndexedDB 导入委托给 Library，避免云端条目进入本地批量操作集合。
 *
 * @param book 百度 API 列表返回的文件名、大小和 uint64 fs_id
 * @param loading 下载及本地缓存过程中的禁用/进度状态
 * @param onOpen 处理权限检查、下载、缓存并将书籍加入阅读器的回调
 */
export const BaiduBookTile: React.FC<BaiduBookTileProps> = ({
  book,
  loading = false,
  onOpen,
}) => {
  const t = useTranslation()
  // 保留失败原因：下载失败可能是鉴权、目录校验或百度接口返回，笼统提示无法定位。
  const [error, setError] = useState<string>()

  const onFailure = (cause: unknown) =>
    setError(
      cause instanceof Error && cause.message
        ? cause.message
        : t('baidu.error'),
    )

  const open = () => {
    setError(undefined)
    void onOpen(book).catch(onFailure)
  }

  return (
    <li className="relative flex min-w-0 flex-col">
      <button
        type="button"
        className="border-inverse-on-surface relative w-full border text-left"
        aria-label={`${t('baidu.source')}: ${book.server_filename}`}
        disabled={loading}
        onClick={open}
      >
        <span
          className={clsx(
            'absolute bottom-0 h-1 bg-blue-500',
            loading && 'progress-bit w-[5%]',
          )}
        />
        <span className="flex aspect-[9/12] items-center justify-center bg-gray-100 text-4xl text-gray-400">
          EPUB
        </span>
      </button>
      <div
        className="line-clamp-2 text-on-surface-variant typescale-body-small lg:typescale-body-medium mt-2 w-full"
        title={book.server_filename}
      >
        <span className="mr-1 rounded bg-black/60 px-1 text-xs text-white">
          {t('baidu.source')}
        </span>
        {book.server_filename}
      </div>
      {loading && (
        <p
          className="typescale-body-small text-on-surface-variant"
          role="status"
        >
          {t('baidu.downloading')}
        </p>
      )}
      {error && (
        <div className="mt-1">
          <p className="typescale-body-small text-red-600" role="alert">
            {error}
          </p>
          <Button variant="secondary" onClick={open}>
            {t('baidu.retry')}
          </Button>
        </div>
      )}
    </li>
  )
}
