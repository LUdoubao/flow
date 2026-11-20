import { v4 as uuidv4 } from 'uuid'

import ePub, { Book } from '@flow/epubjs'

import { BookRecord, db } from './db'
import { mapExtToMimes } from './mime'
import { unpack } from './sync'

export async function fileToEpub(file: File) {
  const data = await file.arrayBuffer()
  return ePub(data)
}

export async function handleFiles(files: Iterable<File>) {
  const books = await db?.books.toArray()
  const newBooks = []

  for (const file of files) {
    console.log(file)

    if (mapExtToMimes['.zip'].includes(file.type)) {
      unpack(file)
      continue
    }

    if (!mapExtToMimes['.epub'].includes(file.type)) {
      console.error(`Unsupported file type: ${file.type}`)
      continue
    }

    // 本地导入只与本地来源记录按文件名去重，不能复用同名百度网盘书目。
    let book = books?.find((b) => !b.source && b.name === file.name)

    if (!book) {
      book = await addBook(file)
    }

    newBooks.push(book)
  }

  return newBooks
}

export async function addBook(file: File) {
  const epub = await fileToEpub(file)
  const metadata = await epub.loaded.metadata

  const book: BookRecord = {
    id: uuidv4(),
    name: file.name || `${metadata.title}.epub`,
    size: file.size,
    metadata,
    createdAt: Date.now(),
    definitions: [],
    annotations: [],
  }
  db?.books.add(book)
  addFile(book.id, file, epub)
  return book
}

/**
 * 按稳定 fs_id 创建或补齐百度网盘书目缓存，并保留既有阅读进度与标注。
 *
 * <p>先做只读快路径：记录与文件字节都齐全时直接复用，省掉重复解析。
 * 真正的查重与写入放在同一个 IndexedDB 读写事务内——同一对象库的读写事务由浏览器串行执行，
 * 因此同一 fs_id 被并发打开（同标签重复点击或多个页面同时下载）时只会创建一条来源记录。
 * EPUB 解析与封面数据 URL 转换留在事务外，避免占用事务导致 IndexedDB 自动提交。</p>
 *
 * @param fsId 百度网盘文件 ID，作为跨刷新稳定的远端身份
 * @param file 已从百度授权目录下载的 EPUB 文件
 * @returns 持久化来源元数据的本地 BookRecord
 */
export async function addBaiduBook(fsId: string, file: File) {
  const database = db
  // 只按百度 fs_id 查重，不按文件名复用本地记录，避免同名异内容的书被合并。
  if (database) {
    const cached = await database.books
      .filter(
        (book) =>
          book.source?.provider === 'baidu' && book.source.fsId === fsId,
      )
      .first()
    // 完整命中时复用本地 FileRecord，保留阅读进度并避免再次下载。
    if (cached && (await database.files.get(cached.id))) return cached
  }

  const epub = await fileToEpub(file)
  const metadata = await epub.loaded.metadata
  const coverUrl = await epub.coverUrl()
  const cover = coverUrl && (await toDataUrl(coverUrl))
  const name = file.name || `${metadata.title}.epub`

  const book: BookRecord = {
    id: uuidv4(),
    name,
    size: file.size,
    metadata,
    createdAt: Date.now(),
    definitions: [],
    annotations: [],
    source: { provider: 'baidu', fsId },
  }

  if (!database) return book

  return database.transaction(
    'rw',
    database.books,
    database.files,
    database.covers,
    async () => {
      // 事务内再次按 fs_id 查重：并发调用被串行化，后到的事务能看到先到的记录。
      const existing = await database.books
        .filter(
          (item) =>
            item.source?.provider === 'baidu' && item.source.fsId === fsId,
        )
        .first()

      if (existing) {
        // 保留 CFI、批注与排版设置，仅补齐文件字节、封面和刷新后的基础元数据。
        const updatedBook: BookRecord = {
          ...existing,
          name,
          size: file.size,
          metadata,
        }
        await database.files.put({ id: existing.id, file })
        await database.covers.put({ id: existing.id, cover })
        await database.books.put(updatedBook)
        return updatedBook
      }

      // 同一事务提交二进制、封面和来源记录，任一写入失败时不会留下不完整书目。
      await database.files.put({ id: book.id, file })
      await database.covers.put({ id: book.id, cover })
      await database.books.add(book)
      return book
    },
  )
}

export async function addFile(id: string, file: File, epub?: Book) {
  db?.files.add({ id, file })

  if (!epub) {
    epub = await fileToEpub(file)
  }

  const url = await epub.coverUrl()
  const cover = url && (await toDataUrl(url))
  db?.covers.add({ id, cover })
}

export function readBlob(fn: (reader: FileReader) => void) {
  return new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      resolve(reader.result as string)
    })
    fn(reader)
  })
}

async function toDataUrl(url: string) {
  const res = await fetch(url)
  const buffer = await res.blob()
  return readBlob((r) => r.readAsDataURL(buffer))
}

export async function fetchBook(url: string) {
  const filename = decodeURIComponent(/\/([^/]*\.epub)$/i.exec(url)?.[1] ?? '')
  const books = await db?.books.toArray()
  const book = books?.find((b) => !b.source && b.name === filename)

  return (
    book ??
    fetch(url)
      .then((res) => res.blob())
      .then((blob) => addBook(new File([blob], filename)))
  )
}
