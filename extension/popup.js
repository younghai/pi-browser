// 연결 상태 확인
async function checkStatus() {
  const statusEl = document.getElementById("status");

  try {
    // background에서 상태 확인
    const response = await chrome.runtime.sendMessage({ type: "getStatus" });
    if (response?.connected) {
      statusEl.className = "status connected";
      statusEl.textContent = "✓ 연결됨";
    } else {
      statusEl.className = "status disconnected";
      statusEl.textContent = "연결 대기 중...";
    }
  } catch (e) {
    statusEl.className = "status disconnected";
    statusEl.textContent = "연결 대기 중...";
  }
}

checkStatus();
setInterval(checkStatus, 2000);
