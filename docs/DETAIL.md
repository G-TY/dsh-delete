# DSH-delete 实现细节

## 为什么"先归档才能删"

DSH 的会话模型里没有删除操作：`workspaceRegistry` 只提供 `archiveSession` / `unarchiveSession` / `pinSession` / `unpinSession` 和 `detachSession`（workspace 本身才有 `delete`）。会话数据活在磁盘上：

```
<DSH_HOME>/sessions/<--工作区分组-->/session-<uuid>/session.v4.jsonl.zstd
<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json   # 投影缓存
<DSH_HOME>/storages/workspace.json                                # 归档/置顶/分组登记
```

所以"删除"只能是插件自己做的事：删目录 + 缓存，再把这一行从内存里的工作区成员中摘掉。

既然无法撤销，就把它绑在**归档之后**：归档是用户显式按过一次的动作，菜单项只对已归档会话出现，两次动作把误删概率压到很低。宿主端还会重新核对磁盘上的归档列表，不信任 UI 传来的意图。

## 为什么删完要动注册表

`WorkspaceEntity.sessionIds` 不是直接读记录，而是 `record.sessionIds.filter(id => host.candidateMatches(id, record.path))`，而 `candidateMatches` 依赖启动时由磁盘 header 建好的 `sessionPaths`。**删掉会话目录并不会清 `sessionPaths`**，于是内存里该 id 仍算成员，侧栏那一行会一直留着，直到下次启动重新索引（那时 `candidateMatches` 才返回假，行被过滤掉）。

所以删除成功后插件再补三步（best effort，失败只损失"立刻消失"，重启仍会消失）：

1. `registry.list()` 里找到 `sessionIds.includes(id)` 的 workspace，`await owner.detachSession(id)` —— 写回 `sessionIds` 去掉这个 id；
2. `await registry.unarchiveSession(id)` —— 从 `global.archivedSessionIds` 里摘掉，避免留下一个指向已删数据的归档标记（该调用不做存在性检查，删过的 id 也能安全清）；
3. `ctx.emit('api-session/removed', id)` —— 这一步才是"行真的消失"的关键。浏览器侧 `sessions` 服务只认两条推送（`api-session/added` / `api-session/removed`，见 `dsh-api-remotes/src/remote-events.ts` 的白名单），它把这条 summary 从列表里删掉后，`groupByWorkspace()` 遍历时就取不到该行，工作区和「未分组」都不会再有它。只做第 1 步而不广播，行会从工作区挪到「未分组」——因为 sessions 列表仍然认这条会话。

## 为什么删完还要复查投影缓存

`dsh-session-projection-cache` 是写回式缓存，共有三个落盘点：会话创建（`session/created`）、回合内按事件数/时间节流、以及会话离开内存（`session/disposed`）。删除时这个会话可能还留在宿主的 live 集合里，它的最后一次 checkpoint 就会在我们 `rm` 之后落地，重新生成一个只有 `identity` + `rows` 的壳文件。它不含正文、也不影响侧栏（列表按磁盘目录列举），但会让"文件管理器里到底删没删干净"变得说不清。

所以删除成功后按 `2s / 5s / 10s / 20s / 40s / 60s` 复查六次，文件在就再删一次（`fsp.rm(..., {force:true})` 对不存在的路径是空操作）。定时器全部 `unref()`，并在插件卸载时清理，不会拖住宿主退出。测试可用环境变量 `DSH_DELETE_SWEEP_DELAYS="20,80"` 把间隔改短（仅用于 `test/host-smoke.mjs`）。



## 为什么还要清 bili 的索引

装过 billion-context（bili）压缩代理的机器上，会话还多一份"外账"：代理自己按 session id 记成本、块、消息引用，存在

```
~/.local/share/billion-context/sessions/index.db     # XDG_DATA_HOME 或 BILI_SESSIONS_DIR 可改位置
```

DSH 的删除是纯文件系统操作，代理收不到任何通知；它也没有提供删除会话的 HTTP 接口（路由表里只有 `/__bili/sessions`、`/sessions/<id>/detail|tree|message` 这些读接口，写到磁盘的只有内部 `deleteSession(id)`）。结果是：DSH 里删掉的会话，在 bili 的「会话」面板里永远留着，并且因为它的 `status` 落盘就是 `active`，一直显示「运行中」。

所以删除成功后插件顺手清掉这个索引里该 id 的行（`messages / refs / blocks / session_ext / ccr_entries / checkpoints / message_media / dead_refs / conversations / sessions`，每张表都按 `session_id` 过滤，缺表就跳过），事前一是一次 `VACUUM INTO` 完整快照（`index.db.dsh-delete-<时间戳>`，保留最近 3 份；`DSH_DELETE_BILI_BACKUP=0` 可关）。索引里没有这条记录时直接返回，不做多余的备份。

仍然清不掉的一层：代理是**长驻守护进程**（`billion-context/dist/index.js start --host 127.0.0.1 --port <port>`，DSH 重启不会重启它），它把见过的会话放在进程内存里，列表是"内存 + 磁盘"的合并结果，而它没有任何接口能丢下一条内存里的会话。那部分影子要等代理进程重启才会消失；索引清干净后，它们也不会再从磁盘长回来。响应里的 `bili` 字段（`{present, purged, removedRows, reason?}`）会告诉你这一步的结果。

## 宿主半身（`index.js`）

`inject: ['webServer', 'workspaceRegistry']`，`POST /dsh-delete/delete`，`kind: 'exact'`，`ctx.webServer.register` 注册，`ctx.effect` 清理。

检查顺序：

| 检查 | 结果 |
| --- | --- |
| 方法不是 POST | 405 `method` |
| `sec-fetch-site: cross-site` 或 Origin 与 Host 不同源 | 403 `origin` |
| 请求体不是合法 JSON | 400 `body` |
| sessionId 不匹配 `^session-<8>-<4>-<4>-<4>-<12>$` | 400 `id` |
| `sessions/*/<id>` 一个目录都没有（已删过的重试） | **200 `{removed: 0}` + 清残行** |
| 不在 `workspace.json` 的 `global.archivedSessionIds` 里 | 409 `not-archived` |
| 投影缓存显示回合未结束（`turnBoundary.val.openTurnStartSeq` 或 `approvalState.val.turnOpen`） | 409 `running` |
| 删除失败（IO） | 500 `io` |
| 全部通过 | 200 `{ok, sessionId, removed, detached, unarchived, announced, bili}` |

"没有目录"排在归档检查之前，是因为重复点击时旧版留下的正是这种状态：数据已经没了，只剩一行残影，此时报"找不到"没有意义，顺手清行并回报成功才符合预期。

`removed` 是实际删掉的会话目录数（同一 id 理论上只会在一个分组下，但扫描不假设这一点）。

`trustedRequest` 只做最基本的同源判断；宿主自己的 `connection` 服务另有更严格的鉴权闸门，本插件不绕过它。

## 客户端半身（`client.js`）

直接手写 `window.__ModuleLoader__.load({ id: 'dsh-delete', factory(require) {…} })`，**不需要构建**。运行时 require 两个模块：`react`，以及 `@deepseek-ai/dsh-client-ui-primitives`（DSH 自带的 UI 基础库，`Modal` / `Button` 就来自这里）。

`inject: ['contextMenus', 'locale', 'workspaces', 'slots']`：

- `locale.register('dshDelete', {zh, en})` —— 词条走 `ctx.locale.bind('dshDelete')`，菜单 label 是 `t('action')`，由 locale 服务渲染成「删除对话」。
- `contextMenus.register({ id: 'dsh-delete', target: 'session', order: 900, resolve })` —— `target` 是会话行的 kind；`resolve` 拿到 `target.value`（会话 id 或会话行记录）；`observe` 订阅归档列表与语言，归档状态一变菜单就重算。
- `ctx.workspaces.list.getSnapshot().archivedSessionIds` —— 判断这一行是否归档。**这就是"只对已归档显示"的实现**：未归档直接返回 `[]`，菜单项根本不存在。

`resolve` 返回的 action：

```js
{
  id: 'delete',
  label: t('action'),
  danger: true,                   // DSH 自己把 danger 动作画成红色
  afterContent: true,             // 与内置「归档/取消归档」同一个 menu footer ⇒ 排在它下面
  icon: { key: 'dsh-delete.trash' }, // 关键：有图标才有图标列，标签才会和「取消归档」左对齐
  run: async () => {…},
}
```

- 菜单渲染的顺序规则（`dsh-client-ui-context-menu`）：`items.filter(i => !i.afterContent)` 进主列表、`items.filter(i => i.afterContent)` 进 `footer`。内置归档项用的是 `order: 600, afterContent: true`，我们用 `order: 900` 跟着进 footer，于是稳排在「取消归档」下面。
- **不要 `separatorBefore`**：footer 里只有这两项，中间再加分隔线反而多余。主列表与 footer 之间本来就有分隔线。
- 图标走 `contextMenu.icon` 这个 **keyed root slot**：`ctx.slots.register({ name: 'contextMenu.icon', key: 'dsh-delete.trash' }, primitives.IconTrashOutlineRegular)`，然后 action 里写 `icon: { key: 'dsh-delete.trash' }`。DSH 内置项用的是 `workspace.*` 系列键，key 必须唯一，不能借用它们的键。
- 没有 `failureLabel`、label 没有省略号 —— 菜单上就是红色的「删除对话」四个字。

### 确认框

- 组件通过 `ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-delete-confirm' }, Overlay))` 挂到应用根浮层，渲染 `primitives.Modal`（`open/onClose/closeLabel/title/description/footer`）+ 两个 `primitives.Button`（`variant: 'outline'`），和 DSH 自己的「删除工作区」对话框结构完全一致。
- 确认流程是一个极小 store：`askConfirm()` 返回 Promise 并广播，`Overlay` 用 `useState + useEffect(subscribe)` 跟着重渲染；点「取消」/关闭按钮/标题栏 X 都 resolve `false`，点「删除对话」resolve `true`。
- 破坏性按钮加 `.dsh-delete-danger`：**红底白字**（`#d92d20` 填充 + 白字，hover 用 `#b42318`），尺寸、内边距、圆角、描边宽度与旁边的「取消」完全一致 —— 只换颜色，不放大按钮。样式由注入的一个 `<style data-dsh-delete>` 提供，并在 effect 清理时移除。
- 框里只有标题、一句说明和两个按钮；**不显示会话标题**（行本身已经高亮，重复一遍反而吵）。
- 拿不到 primitives 时（极老的 DSH）自动退回 `window.confirm`，功能不至于消失。
- `run` 拿到 `true` 才 POST；成功 `notify(t('done'), true)`；失败 `notify(`${t('failed')}：${reason}`, false)` —— 把宿主返回的具体原因（未归档 / 还在跑 / IO）显示出来，而不是含糊的一句"删除失败"。

## 设置（bili 索引清理默认关闭）

bili 的 `index.db` 是**另一个程序的数据库**，所以插件默认不碰它：

- 宿主导出 `SETTINGS_DEFAULTS = { purgeBiliIndex: false }`、`normalizeSettings`（只认 `=== true`）、`createSettingsStore({file, readText, writeText})`（内存缓存 + 容错读 + 合并写），文件是 `$DSH_HOME/dsh-delete.json`。
- 路由 `GET|POST /dsh-delete/settings`（`createSettingsHandler(store)`）；`POST` 走与删除路由同一套 `trustedRequest` + 4 KB body 限制。
- `deleteSession()` 一开始就 `await store.read()`，只有 `purgeBiliIndex === true` 才调 `purgeBiliIndex()`，否则响应里是 `bili: { skipped: true }`，磁盘上一个字节都不动。
- 客户端在 **设置 → 删除对话**（`settings.section`，`id: 'dsh-delete'`, `order: 120`, `locale: 'dshDelete'`）里放一个复选框 + 说明，读写走上面两条路由；保存失败会回滚勾选状态并显示原因。

## 已知边界

- 运行中（回合未结束）的会话不能删；先让它停下或结束。
- 只删会话本体，不动附件、账本、泡泡配置。
- bili 索引可以清（默认关），但代理进程内存里的"活会话"影子要等它自己重启才会消失（见上一节）。
- 宿主代码改动后需要重启 DSH 才生效（模块在启动时 import）；客户端改动刷新页面即可。
- 界面文字跟随 DSH 客户端语言，非中文一律回退英文（`locale` 里注册了 zh + en 两套）。

## 验收清单

```powershell
node --check index.js
node --check client.js
node test\host-smoke.mjs     # 405/403/400/409 not-archived/409 running/200 清残行/200 真删/detach/bili 默认不动与开启后清理+备份/settings 读写
node test\client-smoke.mjs   # entry id / inject / 归档门禁 / 纯文字 label / confirm / 失败提示 / settings.section 注册
```

人工验收：

1. 归档一条会话 → 刷新页面 → 该行 `⋯` 出现「删除对话」。
2. 未归档的会话 → `⋯` 里没有这一项。
3. 点「删除对话」→ 确认 → 提示「已删除这个对话」→ 磁盘上 `sessions/*/session-<id>` 与投影缓存都没了，**侧栏那一行同时消失**，不用重启。
4. 对运行中的会话点删除 → 提示原因，文件仍在。
5. 对已删会话再点一次（若残行还没清）→ 提示「已删除这个对话」并把残行清掉。
6. 设置 → 删除对话：开关默认是关的；打开后 `~/.dsh/dsh-delete.json` 里出现 `{"purgeBiliIndex": true}`。
7. 装过 bili 的机器：开关打开后删一条 → 打开 bili 面板，该会话已不在列表里（进程内存里的旧影子要等 bili 重启）；`~/.local/share/billion-context/sessions/` 下能看到新的 `index.db.dsh-delete-*` 备份。开关关着时删一条 → 索引文件完全没被写。
