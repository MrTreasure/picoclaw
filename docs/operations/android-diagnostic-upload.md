# Android 一键诊断日志

在 MuseC137 Android 中打开“设置 → 一键上传诊断日志”。应用使用本机已保存的设备凭据上传，
不需要二维码、临时工单或再次输入登录 Key。

服务端固定保存目录为 `/vol1/picoclaw/home/android-diagnostics/`。用户告知“日志已上传”后，
读取该目录按修改时间排序的最新 JSON 文件即可；文件名包含 UTC 时间与设备 ID，不包含凭据。

诊断包限制为 1 MiB，仅记录应用/系统版本、网络接口结果、WebSocket 状态及
键盘 inset。客户端日志记录器拒绝写入 token、Authorization、password、api_key、消息正文等字段。
