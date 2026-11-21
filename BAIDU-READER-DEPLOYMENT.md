# 百度网盘书籍网格展示：部署与验证手册

供后续 Agent 在 Linux 服务器部署已审查的“百度网盘 EPUB 并入书库网格”改动。目标服务为 `https://gin.hk.cn/flow/`，仓库根目录 Docker Compose 仅运行阅读器。

> 不要在文档、命令参数、终端回显、Docker build args 或 Git 中写入 AppKey/SecretKey、OAuth token 或用户文件内容。

## 1. 部署输入与前置条件

- 百度应用名称：`文件树索引助手`；应用目录：`/apps/文件树索引助手`。
- 百度 AppId：`124734331`。AppKey/SecretKey 由凭据保管系统提供，使用私密凭据流程读取。
- 百度控制台 OAuth 回调地址必须精确登记为 `https://gin.hk.cn/flow/api/callback/baidu`。
- 服务器：`115.191.9.196`；服务目录：`/opt/flow`。通过 SSH 密钥登录，不在文档或脚本保存 root 密码。
- Nginx 已有 `/flow` 反向代理至 `172.17.0.1:3000`；reader Compose 映射应保持 `172.17.0.1:3000:3000`。部署不得重写或重载 Nginx，除非任务另行授权。
- 现有版本部署于 `/opt/flow`，百度运行环境文件为 `/opt/flow/apps/reader/.env.local`，权限应为 `600`；部署时保留该文件，不要用归档覆盖。

## 2. 预检与变更边界

部署前通过 SSH 记录系统与服务状态：

```sh
ssh root@115.191.9.196 'date -Is; df -hP /; free -h; docker ps --format "{{.Names}} {{.Status}} {{.Image}}"; stat -c "%a %s" /opt/flow/apps/reader/.env.local'
```

确认 reader、`qingshu-front`、MySQL 等当前服务状态；本部署只允许替换 `reader` 容器，不得停止或删除其他容器、镜像、卷、数据库数据或备份。磁盘/内存仅记录，不作为部署中断阈值；若 Docker 构建耗时异常，先检查 BuildKit、网络和进程，不要重复并发构建。

部署边界：上传审查通过的 reader 源码、构建并替换 reader、做 HTTP 冒烟；不更改 Nginx、数据库、百度云端文件或用户凭据。

## 3. 百度运行环境

在服务器创建或维护 `/opt/flow/apps/reader/.env.local`，包含下列变量；Secret 值由私密凭据流程注入，不进入 Git：

```dotenv
NEXT_PUBLIC_DROPBOX_CLIENT_ID=
DROPBOX_CLIENT_SECRET=
NEXT_PUBLIC_WEBSITE_URL=https://gin.hk.cn
BAIDU_APP_ID=124734331
BAIDU_APP_NAME=文件树索引助手
BAIDU_APP_KEY=<从私密凭据安全注入>
BAIDU_SECRET_KEY=<从私密凭据安全注入>
BAIDU_REDIRECT_URI=https://gin.hk.cn/flow/api/callback/baidu
```

文件需使用 UTF-8 编码，确保 `BAIDU_APP_NAME` 原样写入；乱码会导致 `/apps/{appname}` 路径错误并由百度返回 `-9`。设置 `chmod 600`，核对时只显示变量名、文件权限和应用名 UTF-8 十六进制，不回显密钥。

## 4. 打包与传输源码

在含目标实现的干净工作树创建源码归档，排除 Git、依赖、构建产物和全部环境文件。示例（在仓库根目录执行）：

```sh
tar -czf /tmp/flow-reader-deploy.tar.gz \
  --exclude=.git --exclude=node_modules --exclude=.next --exclude=.turbo \
  --exclude=.agent-workflow --exclude='**/.env*' .
scp /tmp/flow-reader-deploy.tar.gz root@115.191.9.196:/tmp/flow-reader-deploy.tar.gz
```

服务器先备份当前 Compose 文件与 reader 镜像标识，再解包到 `/opt/flow`。不得解包到 `.env.local`，也不得删除未纳入本任务的文件。

## 5. 构建、替换及回滚

1. `cd /opt/flow`；验证 `docker compose config --quiet`，确认 compose 端口仍只绑定 `172.17.0.1:3000`、百度环境文件权限仍为 `600`。
2. 使用仓库 Dockerfile 构建 reader：

   ```sh
   docker compose build reader
   ```

   Dockerfile 使用 Node 20、pnpm 10.6.4，并在 build 阶段以 `FLOW_BASE_PATH=/flow` 生成 Next standalone 产物。首次安装 1900+ workspace 依赖需要数分钟；此前 registry 有短暂网络重试，遇到长时间无进度时应检查 BuildKit 日志及网络，不要同时启动第二个构建。

   如果确认卡在 `turbo prune` 的 `pnpm dlx turbo@1.11.3` 阶段，可跳过 prune，使用完整 workspace 依赖构建。先在 `/opt/flow` 写入临时 `/tmp/Dockerfile.direct`（不改仓库 Dockerfile）：

   ```dockerfile
   FROM node:20-bookworm-slim AS builder
   WORKDIR /app
   RUN corepack enable && corepack prepare pnpm@10.6.4 --activate
   COPY . .
   RUN pnpm install --frozen-lockfile
   ARG FLOW_BASE_PATH=/flow
   RUN DOCKER=1 FLOW_BASE_PATH=${FLOW_BASE_PATH} pnpm --filter @flow/reader build
   FROM node:20-bookworm-slim AS runner
   WORKDIR /app
   RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
   ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 FLOW_BASE_PATH=/flow
   USER nextjs
   COPY --from=builder /app/apps/reader/next.config.js ./apps/reader/next.config.js
   COPY --from=builder /app/apps/reader/package.json ./apps/reader/package.json
   COPY --from=builder --chown=nextjs:nodejs /app/apps/reader/public ./apps/reader/public
   COPY --from=builder --chown=nextjs:nodejs /app/apps/reader/.next/standalone ./
   COPY --from=builder --chown=nextjs:nodejs /app/apps/reader/.next/static ./apps/reader/.next/static
   CMD ["node", "apps/reader/server.js"]
   ```

   通过该文件构建到 Compose 使用的同名镜像，再禁止 Compose 隐式重建后只替换 reader：

   ```sh
   DOCKER_BUILDKIT=1 docker build -f /tmp/Dockerfile.direct --target runner -t flow-reader:latest .
   docker compose up -d --no-deps --no-build reader
   ```

   `.dockerignore` 排除 `**/.env*`，Secret 只由 Compose 运行时 `env_file` 注入；不得添加 Docker `ARG`/`ENV` 传递 Secret。

3. 镜像成功后替换 reader，不触碰其他服务：

   ```sh
   docker compose up -d --no-deps reader
   docker ps --filter name=^/reader$ --format '{{.Names}} {{.Status}} {{.Image}}'
   docker logs --tail 100 reader
   ```

4. 若新容器无法启动或冒烟失败，使用部署前记录的 reader 镜像 ID/tag 重新标记为 `flow-reader:latest` 并仅重建 reader；保留当前日志和配置用于排障。不要回滚百度 OAuth Secret 或清理数据卷。

## 6. 功能验证

- `curl -k -I https://gin.hk.cn/flow/` 应得到 Next 路径规范化重定向（308），随后 `/flow` 返回 200。
- `https://gin.hk.cn/` 继续由现有站点处理并返回 200；检查 `/flow/_next/...`、`/flow/manifest.json` 与 `/flow/sw.js` 静态资源成功。
- 浏览器刷新页面，确认百度连接控件在本地图书导入控件同一工具栏，不再显示独立的大型书目卡片；云端 EPUB 与本地书出现在同一个封面网格，每个百度条目标有“百度网盘”。
- OAuth 未连接时 `/flow/api/baidu/files` 返回 401 是正常结果；完成授权后该接口应返回应用目录 `/apps/文件树索引助手` 内 EPUB 列表。
- 点击云端书：仅下载到当前浏览器、保存到 IndexedDB 并打开阅读；相同 `fs_id` 不重复建记录。相同文件名的本地书和百度网盘书仍是两个网格项。
- 删除缓存的百度条目只删本地 IndexedDB，不调用百度删除 API；清理后云端原文件仍保留，刷新网盘列表后仍可重新打开。
- 对下载大于 50 MiB 的 EPUB，接口应拒绝并给出错误；不得继续缓冲或写入 IndexedDB。

## 7. 当前实现与操作约定

- 百度未缓存文件为云端网格磁贴；打开后才下载、生成来源为 `baidu` 的 `BookRecord` 并保存在本地 IndexedDB。
- `BookRecord.source` 为可选属性，不改变 Dexie schema；缺少该属性的旧记录仍作为本地来源。
- 同步给 Dropbox 时只发送本地来源记录；百度来源书不得混入 Dropbox 的清单匹配、上传或远端删除。
- Access/Refresh Token 使用服务端 HttpOnly Cookie；刷新必须保存百度返回的轮换 Refresh Token。浏览器只访问同源 Flow API。

## 8. 已知构建注意事项

- Windows 工作树 `next build` 在 standalone symlink 收集阶段可能因 Windows 权限返回 `EPERM`；应以 Linux Docker 构建结果验证，不要因此修改业务代码。
- Docker build 中 Next 12 可能打印 ESLint 配置加载警告；仍须确认最终 `Compiled successfully`、页面生成完成且镜像导出成功。若 build 进程失败，禁止运行 `docker compose up`。
- 仓库 `Dockerfile` 的 `turbo prune` 在服务器存在网络慢/无进展现象；本指南记录重试时先排查 registry 与 BuildKit。使用替代 Dockerfile 前，应保证依赖锁文件、Next basePath、standalone public/static 复制及非 root runner 设置均一致，并经审查后再部署。
