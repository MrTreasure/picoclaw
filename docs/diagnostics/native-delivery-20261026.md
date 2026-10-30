# 原生聊天送达与重连诊断（2026-10-26）

用户目标是微信原生 App 的消息体验：即时本地回显、逐条状态、断网续传、同一条重试不重复、历史稳定。不是比较微信 bot 渠道，也不推测微信私有协议。

## 证据

- 最新上传：20261026T054138.409726437Z，APK 0.1.38 / Android 36，最近 400 个事件覆盖约 11 分钟。
- 134 条连接丢失记录、88 条 Muse socket failure、23 条 Codex socket failure；大量 HTTP 503。
- 两次 message_prepare / message_submitted，未出现 message_receipt。
- gateway_panic.log 中 `R2ImagePublisher.Sweep(0x0)` 空指针累计 598 次。媒体清理每五分钟触发，systemd 持续自动重启。
- 网关实际来自 `/vol1/1000/workspace/picoclaw`；18801 Launcher 来自 `/vol1/1000/workspace/musec137-pwa`。网关源码缺少此前 Launcher 分支中的 ClientMessageID 保存和 Pico typing 生命周期修复。
- 鉴权只读查询定位到日志对应会话：10 月 26 日近期四条 user 历史均未保存 client_message_id。10 月 23 日有两条正文和客户端 ID 都相同的 user 记录，落盘时间仅差约 7ms，证明确有重复历史；这不能单独证明工具执行次数。
- 原生旧链路依赖历史轮询确认，恢复草稿会生成新发送 ID，缺少服务端持久接收去重；断线与历史同步因此会放大成待核实、重复回显和重复提交风险。

## 已改动

1. 修复 Go typed-nil ImagePublisher：未配置时注入真正 nil；Sweep 对 nil receiver 安全。恢复主请求及 steering 的 ClientMessageID 持久化。
2. 新增网关持久 inbox（home/message-inbox，目录 0700 / 文件 0600）。写入、fsync、原子替换和目录同步完成后才回执。会话和请求 ID 组成身份；同一 ID 的不同正文拒绝接受。
3. 重试同一 ID 复用原回执；同进程投递去重，执行前持久 Claim，防止重复执行同一入站消息。重启恢复 queued；可能已执行工具的 processing 转 interrupted，不盲目重放工具副作用。
4. 接收状态与任务完成分离。连接建立提供协议能力及运行状态；中断产生稳定 ID 提示。typing.stop 仅在实际任务结束时发出，避免工具输出或插入消息触发假结束。
5. Android 先持久化 outbox 并回显、清理已提交草稿，再联网。离线可排队；恢复连接立即查询回执，未知且属于新版记录时按原 ID 补发。明确失败可逐条原 ID 重试。
6. 删除底部人工核实列表；待发送、发送中、等待连接恢复、失败与重试放到对应气泡。旧 APK 不明确的发送记录不自动重发。
7. user 历史使用 client_message_id 作为稳定 UI key。无 ID 的旧记录仅在唯一正文/附件、未改变历史锚点条件下关联，保留 outboxLegacyMatched 原备份；歧义不猜测。部分实时回复与最终历史合并，保留不同 ID 的有意同文发送。
8. 缓存会话不再全部维持重连；活跃会话、运行任务和新版待发送记录才保持恢复。发送错误不再把正在运行的其他回复标为失败。
9. 根据用户最新反馈，输入区从两层改为单行起步、多行增高；底色和边框加强，聚焦边框琥珀色，百分比浮层入口保留。

## 核对

- 故障修复部署后，跨多个原来的五分钟周期无自动重启。
- Go 定向验证：空指针清理、持久回执、重启恢复、同 ID 双提交只入队一次、冲突 ID、会话隔离、离线 typing 生命周期、既有文本和语音输入元数据。
- Kotlin 定向验证：回显与历史单条合并、有意同文不同 ID 保留、旧记录唯一关联和歧义保留、半截流式被最终历史替代。
- Android assemblePreview / lintPreview 通过；最终包含紧凑输入区。
- 使用临时设备通过真实 18801 鉴权 WebSocket，收到 delivery.ready version=1；查询未知 receipt 正确返回 unknown，没有向生产模型提交测试消息。验证设备随后撤销。
- 未进行真机手势、断网、杀进程或弱网自动化；不把单元验证和编译称作微信级体验已验收。

## 运行源约定

网关维护源为 picoclaw，18801 Launcher 维护源为 musec137-pwa，Android 为 musec137-native。不能再因重建另一份网关源码覆盖消息协议补丁。新 APK 的安全重试依赖 delivery.ready version=1 能力声明，旧服务无能力时不会盲目重发。

inbox 回执表示服务器已可靠保存输入，不表示 AI 完成任务。已开始任务在进程崩溃后明确中断，避免自动重复执行外部操作。旧版缺失身份且无法唯一关联的记录仍保留在对应消息处等待同步。
