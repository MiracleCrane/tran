# [P1] 附件不按会话隔离，切会话后串到别的会话

标签：`bug` `P1`

## 复现

1. 在会话 A 添加附件，**不发送**
2. 切到会话 B
3. 附件仍在输入框里，会跟着 B 的下一条消息发出去

## 根因

`Composer.tsx:287`：

```ts
const [attachments, setAttachments] = useState<PickedFile[]>([])
```

草稿**文本**按 `draftKey` 正确隔离（`sessionStore.composerDrafts`，:263-273），但 `attachments` 是常驻挂载组件的本地 state，**切会话时无人重置**（Composer 不随会话切换重新挂载）。

## 附带问题

`attachmentActionSeqRef` 也不重置。异步的 `onPaste`（:655-688）、`onDrop`（:622-651）、`pickAttachment`（:529-543）只靠这个 seq 判断陈旧性 —— 切换后才 resolve 的 `readFiles`/`FileReader` 会把**上一个会话**的文件追加进当前会话。

## 修复方向

`useEffect` 依赖 `draftKey`，切换时清空 attachments 并递增 seq 作废在途读取。

## 备注

完整报告见 `docs/CODE-REVIEW-2026-07-29.md` F-10。
