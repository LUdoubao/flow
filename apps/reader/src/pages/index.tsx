import { useBoolean } from '@literal-ui/hooks'
import clsx from 'clsx'
import { useLiveQuery } from 'dexie-react-hooks'
import Head from 'next/head'
import { useRouter } from 'next/router'
import React, { useEffect, useState } from 'react'
import {
  MdCheckBox,
  MdCheckBoxOutlineBlank,
  MdCheckCircle,
  MdOutlineFileDownload,
  MdOutlineShare,
} from 'react-icons/md'
import { useSet } from 'react-use'
import { usePrevious } from 'react-use'

import { ReaderGridView, Button, TextField, DropZone } from '../components'
import { BaiduBookTile } from '../components/BaiduBookTile'
import { BaiduDrive, BaiduEpub } from '../components/BaiduDrive'
import { BookRecord, CoverRecord, db } from '../db'
import { addBaiduBook, addFile, fetchBook, handleFiles } from '../file'
import {
  useDisablePinchZooming,
  useLibrary,
  useMobile,
  useRemoteBooks,
  useRemoteFiles,
  useTranslation,
} from '../hooks'
import { reader, useReaderSnapshot } from '../models'
import { lock } from '../styles'
import { dbx, pack, uploadData } from '../sync'
import { copy } from '../utils'

const placeholder = `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect fill="gray" fill-opacity="0" width="1" height="1"/></svg>`

const SOURCE = 'src'

export default function Index() {
  const { focusedTab } = useReaderSnapshot()
  const router = useRouter()
  const src = new URL(window.location.href).searchParams.get(SOURCE)
  const [loading, setLoading] = useState(!!src)

  useDisablePinchZooming()

  useEffect(() => {
    let src = router.query[SOURCE]
    if (!src) return
    if (!Array.isArray(src)) src = [src]

    Promise.all(
      src.map((s) =>
        fetchBook(s).then((b) => {
          reader.addTab(b)
        }),
      ),
    ).finally(() => setLoading(false))
  }, [router.query])

  useEffect(() => {
    if ('launchQueue' in window && 'LaunchParams' in window) {
      window.launchQueue.setConsumer((params) => {
        console.log('launchQueue', params)
        if (params.files.length) {
          Promise.all(params.files.map((f) => f.getFile()))
            .then((files) => handleFiles(files))
            .then((books) => books.forEach((b) => reader.addTab(b)))
        }
      })
    }
  }, [])

  useEffect(() => {
    router.beforePopState(({ url }) => {
      if (url === '/') {
        reader.clear()
      }
      return true
    })
  }, [router])

  return (
    <>
      <Head>
        {/* https://github.com/microsoft/vscode/blob/36fdf6b697cba431beb6e391b5a8c5f3606975a1/src/vs/code/browser/workbench/workbench.html#L16 */}
        {/* Disable pinch zooming */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no"
        />
        <title>{focusedTab?.title ?? 'Flow'}</title>
      </Head>
      <ReaderGridView />
      {loading || <Library />}
    </>
  )
}

const Library: React.FC = () => {
  const books = useLibrary()
  const covers = useLiveQuery(() => db?.covers.toArray() ?? [])
  const t = useTranslation('home')
  // 百度相关文案使用全局命名空间，与 BaiduDrive/BaiduBookTile 共用同一组 key。
  const tb = useTranslation()

  const { data: remoteBooks, mutate: mutateRemoteBooks } = useRemoteBooks()
  const { data: remoteFiles, mutate: mutateRemoteFiles } = useRemoteFiles()
  const previousRemoteBooks = usePrevious(remoteBooks)
  const previousRemoteFiles = usePrevious(remoteFiles)

  const [select, toggleSelect] = useBoolean(false)
  const [selectedBookIds, { add, has, toggle, reset }] = useSet<string>()

  const [loading, setLoading] = useState<string | undefined>()
  const [readyToSync, setReadyToSync] = useState(false)
  const [baiduFiles, setBaiduFiles] = useState<BaiduEpub[]>([])
  const [baiduError, setBaiduError] = useState<string>()

  const { groups } = useReaderSnapshot()

  useEffect(() => {
    if (previousRemoteFiles && remoteFiles) {
      // to remove effect dependency `books`
      db?.books.toArray().then((books) => {
        if (books.length === 0) return

        const newRemoteBooks = remoteFiles.flatMap((file) => {
          // 只匹配本地来源书目，避免同名百度网盘书被当成 Dropbox 同步对象。
          const book = books.find(
            (candidate) => !candidate.source && candidate.name === file.name,
          )
          return book ? [book] : []
        })

        uploadData(newRemoteBooks)
        mutateRemoteBooks(newRemoteBooks, { revalidate: false })
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mutateRemoteBooks, remoteFiles])

  useEffect(() => {
    if (!previousRemoteBooks && remoteBooks) {
      db?.books.bulkPut(remoteBooks).then(() => setReadyToSync(true))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteBooks])

  useEffect(() => {
    if (!remoteFiles || !readyToSync) return

    db?.books.toArray().then(async (books) => {
      for (const remoteFile of remoteFiles) {
        const book = books.find(
          (candidate) =>
            !candidate.source && candidate.name === remoteFile.name,
        )
        if (!book) continue

        const file = await db?.files.get(book.id)
        if (file) continue

        setLoading(book.id)
        await dbx
          .filesDownload({ path: `/files/${remoteFile.name}` })
          .then((d) => {
            const blob: Blob = (d.result as any).fileBlob
            return addFile(book.id, new File([blob], book.name))
          })
        setLoading(undefined)
      }
    })
  }, [readyToSync, remoteFiles])

  useEffect(() => {
    if (!select) reset()
  }, [reset, select])

  if (groups.length) return null
  if (!books) return null

  const localBooks = books.filter((book) => !book.source)
  const baiduBooks = books.filter((book) => book.source?.provider === 'baidu')
  // 列表可能在选择模式下刷新；先丢弃已消失的主键，避免批量操作访问空记录。
  const selectedBooks = [...selectedBookIds].flatMap((id) => {
    const book = books.find((item) => item.id === id)
    return book ? [book] : []
  })
  // 百度书已缓存完整 FileRecord，可参与本地选择/导出/删除；Dropbox 操作仍只作用本地来源书。
  const selectableBooks = [...localBooks, ...baiduBooks]
  const allSelected =
    selectableBooks.length > 0 && selectableBooks.every((book) => has(book.id))

  /**
   * 下载并缓存百度网盘书籍，或直接打开已缓存的副本。
   *
   * <p>按 fs_id 复用既有来源记录；若本地 FileRecord 已被删除，则重新下载补齐，
   * 使已缓存的磁贴仍能从书库恢复到可阅读状态。下载或写库失败时抛出错误，由调用方提示重试。</p>
   *
   * @param fsId 百度网盘文件 ID，跨刷新稳定的远端身份
   * @param fileName 创建 File 时使用的显示文件名
   */
  const openBaiduBook = async (fsId: string, fileName: string) => {
    setBaiduError(undefined)
    setLoading(`baidu:${fsId}`)
    try {
      const cached = books.find(
        (book) =>
          book.source?.provider === 'baidu' && book.source.fsId === fsId,
      )
      if (cached && (await db?.files.get(cached.id))) {
        reader.addTab(cached)
        return
      }

      const response = await fetch(
        `${
          process.env.NEXT_PUBLIC_BASE_PATH || ''
        }/api/baidu/download?fsid=${encodeURIComponent(fsId)}`,
      )
      if (!response.ok) {
        const result = (await response.json()) as { error?: string }
        throw new Error(result.error || tb('baidu.error'))
      }

      // 下载结果先转 File，再由 addBaiduBook 在事务内按 fs_id 幂等写入本地书库。
      const file = new File([await response.blob()], fileName, {
        type: 'application/epub+zip',
      })
      const book = await addBaiduBook(fsId, file)
      reader.addTab(book)
    } finally {
      setLoading(undefined)
    }
  }

  return (
    <DropZone
      className="scroll-parent h-full p-4"
      onDrop={(e) => {
        const bookId = e.dataTransfer.getData('text/plain')
        const book = books.find((b) => b.id === bookId)
        if (book) reader.addTab(book)

        handleFiles(e.dataTransfer.files)
      }}
    >
      <div className="mb-4 space-y-2.5">
        <div>
          <TextField
            name={SOURCE}
            placeholder="https://link.to/remote.epub"
            type="url"
            hideLabel
            actions={[
              {
                title: t('share'),
                Icon: MdOutlineShare,
                onClick(el) {
                  if (el?.reportValidity()) {
                    copy(`${window.location.origin}/?${SOURCE}=${el.value}`)
                  }
                },
              },
              {
                title: t('download'),
                Icon: MdOutlineFileDownload,
                onClick(el) {
                  if (el?.reportValidity()) fetchBook(el.value)
                },
              },
            ]}
          />
        </div>
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <BaiduDrive onFilesChange={setBaiduFiles} />
            {selectableBooks.length ? (
              <Button
                variant="secondary"
                onClick={() => {
                  reset()
                  toggleSelect()
                }}
              >
                {t(select ? 'cancel' : 'select')}
              </Button>
            ) : (
              <Button
                variant="secondary"
                disabled={!books}
                onClick={() => {
                  fetchBook(
                    'https://epubtest.org/books/Fundamental-Accessibility-Tests-Basic-Functionality-v1.0.0.epub',
                  )
                }}
              >
                {t('download_sample_book')}
              </Button>
            )}
            {select &&
              (allSelected ? (
                <Button variant="secondary" onClick={reset}>
                  {t('deselect_all')}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  onClick={() => selectableBooks.forEach((b) => add(b.id))}
                >
                  {t('select_all')}
                </Button>
              ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {select ? (
              <>
                <Button
                  onClick={async () => {
                    toggleSelect()

                    for (const book of selectedBooks) {
                      if (book.source) continue
                      const remoteFile = remoteFiles?.find(
                        (f) => f.name === book.name,
                      )
                      if (remoteFile) continue

                      const file = await db?.files.get(book.id)
                      if (!file) continue

                      setLoading(book.id)
                      await dbx.filesUpload({
                        path: `/files/${book.name}`,
                        contents: file.file,
                      })
                      setLoading(undefined)

                      mutateRemoteFiles()
                    }
                  }}
                >
                  {t('upload')}
                </Button>
                <Button
                  onClick={async () => {
                    toggleSelect()
                    // 删除选中的本地缓存/书目记录；百度来源不会调用 Dropbox 删除 API。
                    const bookIds = selectedBooks.map((book) => book.id)
                    if (bookIds.length === 0) return

                    db?.books.bulkDelete(bookIds)
                    db?.covers.bulkDelete(bookIds)
                    db?.files.bulkDelete(bookIds)

                    // Dropbox 远端删除只作用于 Dropbox 来源书；百度网盘源文件绝不随本地删除联动删除。
                    const dropboxBooks = selectedBooks.filter(
                      (book) => !book.source,
                    )
                    mutateRemoteFiles(
                      async (data) => {
                        if (dropboxBooks.length > 0) {
                          await dbx.filesDeleteBatch({
                            entries: dropboxBooks.map((b) => ({
                              path: `/files/${b.name}`,
                            })),
                          })
                        }
                        return data?.filter(
                          (f) => !dropboxBooks.some((b) => b.name === f.name),
                        )
                      },
                      { revalidate: false },
                    )
                  }}
                >
                  {t('delete')}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="secondary"
                  disabled={!books.length}
                  onClick={pack}
                >
                  {t('export')}
                </Button>
                <Button className="relative">
                  <input
                    type="file"
                    accept="application/epub+zip,application/epub,application/zip"
                    className="absolute inset-0 cursor-pointer opacity-0"
                    onChange={(e) => {
                      const files = e.target.files
                      if (files) handleFiles(files)
                    }}
                    multiple
                  />
                  {t('import')}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="scroll h-full">
        {baiduError && (
          <p className="typescale-body-small mb-2 text-red-600" role="alert">
            {baiduError}
          </p>
        )}
        <ul
          className="grid"
          style={{
            gridTemplateColumns: `repeat(auto-fill, minmax(calc(80px + 3vw), 1fr))`,
            columnGap: lock(16, 32),
            rowGap: lock(24, 40),
          }}
        >
          {localBooks.map((book) => (
            <Book
              key={book.id}
              book={book}
              covers={covers}
              select={select}
              selected={has(book.id)}
              loading={loading === book.id}
              toggle={toggle}
            />
          ))}
          {baiduBooks.map((book) => {
            const fsId = book.source?.fsId
            if (!fsId) return null
            return (
              <Book
                key={book.id}
                book={book}
                covers={covers}
                remoteFile={{ name: book.name }}
                select={select}
                selected={has(book.id)}
                loading={loading === `baidu:${fsId}`}
                // 缓存记录可能缺少文件字节：点击时按 fs_id 重新下载补齐。
                onOpen={async () => {
                  try {
                    await openBaiduBook(fsId, book.name)
                  } catch (cause) {
                    setBaiduError(
                      cause instanceof Error
                        ? cause.message
                        : tb('baidu.error'),
                    )
                  }
                }}
                toggle={toggle}
              />
            )
          })}
          {baiduFiles
            .filter(
              (remoteBook) =>
                !baiduBooks.some(
                  (book) => book.source?.fsId === remoteBook.fs_id,
                ),
            )
            .map((remoteBook) => (
              <BaiduBookTile
                key={`baidu:${remoteBook.fs_id}`}
                book={remoteBook}
                loading={loading === `baidu:${remoteBook.fs_id}`}
                onOpen={(target) =>
                  openBaiduBook(target.fs_id, target.server_filename)
                }
              />
            ))}
        </ul>
      </div>
    </DropZone>
  )
}

interface BookProps {
  book: BookRecord
  covers?: CoverRecord[]
  select?: boolean
  selected?: boolean
  loading?: boolean
  toggle: (id: string) => void
  remoteFile?: { name: string }
  /** 百度来源磁贴的打开入口；本地文件缺失时由它负责重新下载补齐。 */
  onOpen?: () => Promise<void>
}
const Book: React.FC<BookProps> = ({
  book,
  covers,
  select,
  selected,
  loading,
  toggle,
  remoteFile: remoteFileOverride,
  onOpen,
}) => {
  const t = useTranslation()
  const remoteFiles = useRemoteFiles()

  const router = useRouter()
  const mobile = useMobile()

  const cover = covers?.find((c) => c.id === book.id)?.cover
  const remoteFile =
    remoteFileOverride || remoteFiles.data?.find((f) => f.name === book.name)

  const Icon = selected ? MdCheckBox : MdCheckBoxOutlineBlank

  return (
    <div className="relative flex flex-col">
      <div
        role="button"
        className="border-inverse-on-surface relative border"
        onClick={async () => {
          if (select) {
            toggle(book.id)
            return
          }

          if (mobile) await router.push('/_')
          // 百度来源磁贴可能缺少本地文件字节，交由 onOpen 重新下载补齐后再打开。
          if (onOpen) {
            await onOpen()
            return
          }
          reader.addTab(book)
        }}
      >
        <div
          className={clsx(
            'absolute bottom-0 h-1 bg-blue-500',
            loading && 'progress-bit w-[5%]',
          )}
        />
        {book.percentage !== undefined && (
          <div className="typescale-body-large absolute right-0 bg-gray-500/60 px-2 text-gray-100">
            {(book.percentage * 100).toFixed()}%
          </div>
        )}
        <img
          src={cover ?? placeholder}
          alt="Cover"
          className="mx-auto aspect-[9/12] object-cover"
          draggable={false}
        />
        {select && (
          <div className="absolute bottom-1 right-1">
            <Icon
              size={24}
              className={clsx(
                '-m-1',
                selected ? 'text-tertiary' : 'text-outline',
              )}
            />
          </div>
        )}
      </div>

      <div
        className="line-clamp-2 text-on-surface-variant typescale-body-small lg:typescale-body-medium mt-2 w-full"
        title={book.name}
      >
        {book.source?.provider === 'baidu' ? (
          <span className="mr-1 rounded bg-black/60 px-1 text-xs text-white">
            {t('baidu.source')}
          </span>
        ) : (
          <MdCheckCircle
            className={clsx(
              'mr-1 mb-0.5 inline',
              remoteFile ? 'text-tertiary' : 'text-surface-variant',
            )}
            size={16}
          />
        )}
        {book.name}
      </div>
    </div>
  )
}
