# Android 扫码诊断日志

生成一次支持工单二维码：

```bash
scripts/muse-diagnostic-qr.sh
```

在另一块屏幕上打开生成的 SVG，然后在 MuseC137 Android 的“设置 → 扫码上传诊断日志”扫描。
上传需要应用现有设备令牌；二维码只用于关联工单，不包含凭据。服务端文件保存到
`/vol1/picoclaw/home/android-diagnostics/`，文件名包含二维码输出的 ticket。

诊断包限制为 1 MiB，仅记录应用/系统版本、网络接口结果、WebSocket 状态、WebView 错误及
键盘 inset。客户端日志记录器拒绝写入 token、Authorization、password、api_key、消息正文等字段。
