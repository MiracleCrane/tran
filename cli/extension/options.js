// options 页：粘贴配对码 + 展示连接状态（每 2s 轮询 SW）。

const codeInput = document.getElementById('code')
const saveBtn = document.getElementById('save')
const statusBox = document.getElementById('status')

function renderStatus(s) {
  if (!s) {
    statusBox.textContent = '无法获取状态（service worker 未响应）'
    return
  }
  const lines = []
  if (!s.paired) {
    lines.push('状态：未配对')
  } else if (s.connected) {
    lines.push(`状态：✅ 已连接 Tran（端口 ${s.port}，Tran v${s.tranVersion}）`)
  } else {
    lines.push(`状态：未连接（端口 ${s.port}，会自动重试）`)
  }
  if (s.lastError) lines.push(`最近错误：${s.lastError}`)
  lines.push(`扩展版本：${s.extensionVersion}`)
  statusBox.textContent = lines.join('\n')
  statusBox.className = s.connected ? 'ok' : ''
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'get_status' }, (resp) => {
    if (chrome.runtime.lastError) {
      renderStatus(null)
      return
    }
    renderStatus(resp)
  })
}

saveBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'save_pairing', code: codeInput.value }, (resp) => {
    if (chrome.runtime.lastError || !resp) {
      statusBox.textContent = '保存失败（service worker 未响应）'
      return
    }
    if (!resp.ok) {
      statusBox.textContent = resp.error
      statusBox.className = 'err'
      return
    }
    codeInput.value = ''
    statusBox.textContent = '已保存，正在连接…'
    statusBox.className = ''
    setTimeout(refresh, 800)
  })
})

refresh()
setInterval(refresh, 2000)
