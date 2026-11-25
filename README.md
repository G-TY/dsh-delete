# DSH-delete

Adds a **Delete conversation** item to DSH's session menu — the only way to *erase* a session rather than archive it. It only appears for **archived** sessions, sits at the bottom of the menu next to 「取消归档」, uses red text with a trash icon, and asks for confirmation in a dialog built from DSH's own `Modal` + `Button`. On confirm the session folder and its projection cache are removed from disk, the workspace registry forgets it, and the row disappears immediately (no restart needed).

Works in the desktop app and in `dsh web` on any platform; the optional billion-context index cleanup is **off by default** and only touches `index.db` when you turn it on.

---

给 DSH 侧栏的会话行加一个 **删除对话** 菜单项。它**只对已归档的对话出现** —— 先归档、再删除，是两个明确的动作，避免手滑删掉还在用的会话。

菜单项排在「取消归档」**下面**一行，带一个垃圾桶图标、用红字，点它会弹出和 DSH「删除工作区」同款的确认框（应用自己的 `Modal` + `Button`，不是系统弹窗）。

确认后，该对话的数据会从磁盘上彻底移除。

## 用法

1. 侧栏会话行 `⋯` → **归档会话**（这一步是必要的前置，也是防误删的闸门）。
2. 打开侧栏的「全部对话（显示已归档）」筛选，找到那条灰色会话。
3. 再点 `⋯` → **删除对话**（红字，在「取消归档」下面）→ 弹出确认框 → 点红底的「删除对话」。

第一条会话的数据随即从磁盘移除，侧栏那一行也会立刻消失（插件会把它从所在工作区的成员里摘掉、并清掉归档标记，不用等重启）。

## 行为与安全

- **只删已归档的**：菜单项对未归档的会话根本不出现，宿主端还会重新核对一遍磁盘上的归档列表，UI 状态过期也删不动。
- **正在跑的会话删不掉**：检测到未结束的回合就直接拒绝，一个文件都不动。
- **只删会话本体**：`sessions\<分组>\session-<id>\` 和它的投影缓存。附件、小鲸鱼账本与泡泡配置、其它会话都不受影响。
- **不可恢复**：没有回收站，确认框里写明了。
- **失败会说原因**：没归档、找不到文件、还在跑、磁盘错误，都会在提示里带上宿主返回的具体原因，不会只说一句"删除失败"。
- **重复点不报错**：数据已经删过、只剩一行残留时，再点一次会顺手把残行清掉并提示"已删除这个对话"。
- **行当场消失**：除了删文件，宿主还会把这条会话从工作区记账里摘掉，并广播 `api-session/removed`，浏览器收到后立刻把侧栏那一行删掉——不会挪到「未分组」里继续碍眼。
- **bili 索引清理默认关闭**：如果你装了 billion-context（bili）压缩代理，它自己也存了一份会话账本（`~/.local/share/billion-context/sessions/index.db`），DSH 的删除不会通知它。那是另一个程序的数据库，所以插件**默认不碰它**；要清就去 **设置 → 删除对话** 打开「同时清理 bili 的会话索引」。打开后删除时会先 `VACUUM INTO` 做一份完整快照（同目录 `index.db.dsh-delete-*`，保留最近 3 份，`DSH_DELETE_BILI_BACKUP=0` 可关），再按 `session_id` 删行。注意：bili 的守护进程内存里还有一份"活会话"缓存，它没有对外提供删除接口，这部分要等 bili 进程重启后才会消失；索引清掉后不会再从磁盘长回来。
- **不留缓存壳**：DSH 的投影缓存在会话卸载时还会补写一次，可能在你删完之后重新落一个几 KB 的空壳。插件会在删除后 2s / 5s / 10s / 20s / 40s / 60s 复查并清掉，所以在文件管理器里最终两个都不剩。

## 看不到菜单项？

- 只对**已归档**的会话显示（这是设计）。
- 客户端菜单装在浏览器里，装好或改过之后需要 **刷新页面（Ctrl+R）**；宿主端路由会热加载立即生效。
- 刷新后仍没有就重启一次 DSH。

## 语言

界面文字跟随 DSH 客户端语言：中文环境用中文，其它语言一律回退英文（`locale` 里 zh/en 两套都注册了）。

## 设置

**设置 → 删除对话** 里只有一个开关：是否在删除时顺手清理 bili 的索引（默认关）。它存在 `$DSH_HOME/dsh-delete.json`，与 DSH 的数据目录一致（`DSH_HOME` 没设就是 `~/.dsh`）。

## 卸载

在插件管理里移除 `dsh-delete`。

## 文档

实现细节与验收清单见 `docs/DETAIL.md`。
