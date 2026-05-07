const LOCAL_SERVICE = 'http://localhost:47821';

async function checkServiceHealth() {
  try {
    const resp = await fetch(`${LOCAL_SERVICE}/health`, { signal: AbortSignal.timeout(2000) });
    return resp.ok;
  } catch {
    return false;
  }
}

function timeAgo(ts) {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

async function render() {
  const [serviceAlive, status] = await Promise.all([
    checkServiceHealth(),
    new Promise(res => chrome.runtime.sendMessage({ type: 'GET_STATUS' }, res)),
  ]);

  // Service status
  const dot = document.getElementById('service-dot');
  const label = document.getElementById('service-label');
  if (serviceAlive) {
    dot.className = 'dot green';
    label.textContent = 'Desktop service running';
  } else {
    dot.className = 'dot yellow';
    label.textContent = 'Desktop service not running';
  }

  // Sessions list
  const list = document.getElementById('sessions-list');
  const sessions = status?.active_sessions || {};
  const keys = Object.keys(sessions);
  if (keys.length === 0) {
    list.innerHTML = '<div class="no-sessions">No active sessions yet.<br>Log into a dental portal to connect.</div>';
  } else {
    list.innerHTML = keys.map(payer => `
      <div class="session-item">
        <div class="dot green"></div>
        <div class="session-name">${sessions[payer].payerName}</div>
        <div class="session-time">${timeAgo(sessions[payer].capturedAt)}</div>
      </div>
    `).join('');
  }

  // Show register section if not registered
  if (!status?.registered) {
    document.getElementById('register-section').style.display = 'block';
  }
}

document.getElementById('register-btn')?.addEventListener('click', async () => {
  const officeId = document.getElementById('office-id-input').value.trim();
  if (!officeId) return;
  await chrome.runtime.sendMessage({ type: 'REGISTER', office_id: officeId, api_key: '' });
  document.getElementById('register-section').style.display = 'none';
  render();
});

render();
