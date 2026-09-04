const APP_NAME = btoa('TV Fernbedienung');

const statusEl = document.getElementById('status');
const settingsDialog = document.getElementById('settingsDialog');
const tvIpInput = document.getElementById('tvIpInput');
const tvModeSelect = document.getElementById('tvModeSelect');

let socket = null;
let socketReady = false;

function getTvIp() {
  return localStorage.getItem('tvIp') || '';
}

function getToken() {
  return localStorage.getItem('tvToken') || '';
}

function getMode() {
  return localStorage.getItem('tvMode') || 'auto';
}

function useSecure() {
  const mode = getMode();
  if (mode === 'secure') return true;
  if (mode === 'plain') return false;
  return location.protocol === 'https:';
}

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (cls ? ' ' + cls : '');
}

function buildSocketUrl(ip) {
  if (useSecure()) {
    const token = getToken();
    const tokenPart = token ? `&token=${encodeURIComponent(token)}` : '';
    return `wss://${ip}:8002/api/v2/channels/samsung.remote.control?name=${APP_NAME}${tokenPart}`;
  }
  return `ws://${ip}:8001/api/v2/channels/samsung.remote.control?name=${APP_NAME}`;
}

function ensureConnection() {
  return new Promise((resolve, reject) => {
    const ip = getTvIp();
    if (!ip) {
      setStatus('keine IP hinterlegt', 'error');
      settingsDialog.showModal();
      reject(new Error('no-ip'));
      return;
    }

    if (socket && socketReady) {
      resolve(socket);
      return;
    }

    if (socket) {
      try { socket.close(); } catch (e) {}
    }

    setStatus('verbinde…');
    const url = buildSocketUrl(ip);
    const ws = new WebSocket(url);
    socket = ws;
    socketReady = false;

    const timeout = setTimeout(() => {
      ws.close();
      setStatus('Zeitüberschreitung', 'error');
      reject(new Error('timeout'));
    }, 8000);

    ws.addEventListener('open', () => {
      // Warte auf ms.channel.connect Bestätigung statt sofort als bereit zu gelten
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }

      if (msg.event === 'ms.channel.connect') {
        clearTimeout(timeout);
        if (msg.data && msg.data.token) {
          localStorage.setItem('tvToken', msg.data.token);
        }
        socketReady = true;
        setStatus('verbunden', 'connected');
        resolve(ws);
      }

      if (msg.event === 'ms.channel.timeOut' || msg.event === 'ms.error') {
        clearTimeout(timeout);
        socketReady = false;
        setStatus('vom TV abgelehnt', 'error');
        reject(new Error('rejected'));
      }
    });

    ws.addEventListener('error', () => {
      clearTimeout(timeout);
      socketReady = false;
      setStatus('Verbindungsfehler', 'error');
      reject(new Error('socket-error'));
    });

    ws.addEventListener('close', () => {
      clearTimeout(timeout);
      socketReady = false;
      if (statusEl.textContent === 'verbunden') {
        setStatus('getrennt');
      }
    });
  });
}

async function sendKey(key) {
  try {
    const ws = await ensureConnection();
    ws.send(JSON.stringify({
      method: 'ms.remote.control',
      params: {
        Cmd: 'Click',
        DataOfCmd: key,
        Option: 'false',
        TypeOfRemote: 'SendRemoteKey',
      },
    }));
  } catch (e) {
    // Status wurde bereits gesetzt, hier nichts weiter zu tun
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureLiveTvIfNeeded() {
  const profile = getActiveProfileObj();
  if (profile && profile.forceTv) {
    await sendKey('KEY_TV');
    await delay(400);
  }
}

async function sendChannel(channel) {
  await ensureLiveTvIfNeeded();
  const digits = String(channel).replace(/[^0-9]/g, '').split('');
  for (const digit of digits) {
    await sendKey(`KEY_${digit}`);
    await delay(200);
  }
}

async function sendChannelKey(key) {
  await ensureLiveTvIfNeeded();
  await sendKey(key);
}

document.querySelectorAll('[data-key]').forEach((btn) => {
  btn.addEventListener('click', () => sendKey(btn.dataset.key));
});

document.querySelectorAll('[data-channel-key]').forEach((btn) => {
  btn.addEventListener('click', () => sendChannelKey(btn.dataset.channelKey));
});

const powerConfirmDialog = document.getElementById('powerConfirmDialog');

document.getElementById('powerBtn').addEventListener('click', () => {
  powerConfirmDialog.showModal();
});

document.getElementById('powerCancelBtn').addEventListener('click', () => {
  powerConfirmDialog.close();
});

document.getElementById('powerConfirmBtn').addEventListener('click', () => {
  sendKey('KEY_POWER');
  powerConfirmDialog.close();
});

const dpadDialog = document.getElementById('dpadDialog');

document.getElementById('headphoneBtn').addEventListener('click', () => {
  dpadDialog.showModal();
});

document.getElementById('closeDpadBtn').addEventListener('click', () => {
  dpadDialog.close();
});

document.getElementById('hdmiBtn').addEventListener('click', () => sendKey('KEY_HDMI'));

document.getElementById('settingsBtn').addEventListener('click', () => {
  tvIpInput.value = getTvIp();
  tvModeSelect.value = getMode();
  scanBaseInput.value = guessSubnetBase();
  scanStatus.textContent = '';
  scanResults.innerHTML = '';
  settingsDialog.showModal();
});

document.getElementById('settingsForm').addEventListener('submit', () => {
  const ip = tvIpInput.value.trim();
  const oldIp = getTvIp();
  const oldMode = getMode();
  const newMode = tvModeSelect.value;

  if (ip) {
    localStorage.setItem('tvIp', ip);
  }
  localStorage.setItem('tvMode', newMode);

  if (ip !== oldIp || newMode !== oldMode) {
    localStorage.removeItem('tvToken');
    if (socket) { try { socket.close(); } catch (e) {} }
    socketReady = false;
    setStatus('nicht verbunden');
  }
});

const scanBaseInput = document.getElementById('scanBaseInput');
const scanBtn = document.getElementById('scanBtn');
const scanStatus = document.getElementById('scanStatus');
const scanResults = document.getElementById('scanResults');

function guessSubnetBase() {
  const ip = getTvIp();
  if (ip && ip.includes('.')) {
    return ip.split('.').slice(0, 3).join('.');
  }
  return '192.168.1';
}

async function probeHost(ip) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    const res = await fetch(`http://${ip}:8001/api/v2/`, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await res.json();
    if (data && data.device && data.device.OS === 'Tizen') {
      return { ip, name: data.device.name || data.name || 'Samsung Gerät', model: data.device.modelName || '', type: data.device.type || '' };
    }
  } catch (e) {
    clearTimeout(timeout);
  }
  return null;
}

async function scanNetwork() {
  const base = scanBaseInput.value.trim().replace(/\.$/, '');
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(base)) {
    scanStatus.textContent = 'Bitte gültige Adresse eingeben, z.B. 192.168.1';
    return;
  }

  scanBtn.disabled = true;
  scanResults.innerHTML = '';
  const found = [];
  const batchSize = 24;
  const total = 254;

  for (let start = 1; start <= total; start += batchSize) {
    const batch = [];
    for (let i = start; i < Math.min(start + batchSize, total + 1); i++) {
      batch.push(probeHost(`${base}.${i}`));
    }
    scanStatus.textContent = `Suche läuft… ${Math.min(start + batchSize - 1, total)}/${total}`;
    const results = await Promise.all(batch);
    results.forEach((r) => { if (r) found.push(r); });
    renderScanResults(found);
  }

  scanStatus.textContent = found.length
    ? `${found.length} Gerät(e) gefunden.`
    : 'Nichts gefunden. Läuft diese Seite über https, kann die Suche geblockt sein — dann IP manuell eintragen.';
  scanBtn.disabled = false;
}

function renderScanResults(found) {
  scanResults.innerHTML = '';
  found
    .filter((r) => r.type !== 'Samsung Speaker')
    .forEach((r) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'scan-result-btn';
      btn.innerHTML = `${r.name}${r.model ? ' (' + r.model + ')' : ''}<span class="scan-result-ip">${r.ip}</span>`;
      btn.addEventListener('click', () => {
        tvIpInput.value = r.ip;
      });
      scanResults.appendChild(btn);
    });
}

scanBtn.addEventListener('click', scanNetwork);

document.getElementById('forgetBtn').addEventListener('click', () => {
  localStorage.removeItem('tvToken');
  if (socket) { try { socket.close(); } catch (e) {} }
  socketReady = false;
  setStatus('Kopplung vergessen');
  settingsDialog.close();
});

const PROFILE_COLORS = ['#ff375f', '#0a84ff', '#30d158', '#ff9f0a'];
const MAX_PROFILES = 4;
const DEFAULT_PROFILES = [
  { id: 'mama', name: 'Mama', color: PROFILE_COLORS[0], headphones: true, hdmi: false, forceTv: true },
  { id: 'papa', name: 'Papa', color: PROFILE_COLORS[1], headphones: false, hdmi: true, forceTv: false },
];

function getProfiles() {
  try {
    const stored = JSON.parse(localStorage.getItem('tvProfiles'));
    if (Array.isArray(stored) && stored.length) return stored;
  } catch (e) {}
  return DEFAULT_PROFILES;
}

function saveProfiles(profiles) {
  localStorage.setItem('tvProfiles', JSON.stringify(profiles));
}

function getActiveProfile() {
  const profiles = getProfiles();
  const stored = localStorage.getItem('tvProfile');
  if (stored && profiles.some((p) => p.id === stored)) return stored;
  return profiles[0].id;
}

function getActiveProfileObj() {
  return getProfiles().find((p) => p.id === getActiveProfile());
}

function setActiveProfile(id) {
  localStorage.setItem('tvProfile', id);
  applyProfile();
}

const profileSwitchEl = document.getElementById('profileSwitch');

function renderProfileSwitch() {
  const profiles = getProfiles();
  const active = getActiveProfile();
  profileSwitchEl.innerHTML = '';
  profiles.forEach((p) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'profile-btn' + (p.id === active ? ' active' : '');
    btn.textContent = p.name;
    if (p.id === active) {
      btn.style.background = p.color;
      btn.style.borderColor = p.color;
    }
    btn.addEventListener('click', () => {
      setActiveProfile(p.id);
      ensureLiveTvIfNeeded();
    });
    profileSwitchEl.appendChild(btn);
  });
}

function applyProfile() {
  const profile = getActiveProfileObj();
  document.body.style.setProperty('--accent', profile.color);
  renderProfileSwitch();
  document.getElementById('headphoneSection').hidden = !profile.headphones;
  document.getElementById('hdmiSection').hidden = !profile.hdmi;
  renderFavorites();
}

const profilesDialog = document.getElementById('profilesDialog');
const profileEditorEl = document.getElementById('profileEditor');
const addProfileBtn = document.getElementById('addProfileBtn');

function renderProfileEditor() {
  const profiles = getProfiles();
  profileEditorEl.innerHTML = '';
  profiles.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'profile-edit-row';
    row.innerHTML = `
      <div class="profile-edit-top">
        <button type="button" class="profile-color-dot" style="background:${p.color}" aria-label="Farbe ändern"></button>
        <input type="text" class="profile-name-input" value="${p.name}" maxlength="16">
        <button type="button" class="profile-remove-btn" aria-label="Profil entfernen">✕</button>
      </div>
      <div class="profile-edit-options">
        <label><input type="checkbox" class="opt-headphones" ${p.headphones ? 'checked' : ''}> 🎧 Kopfhörer-Menü anzeigen</label>
        <label><input type="checkbox" class="opt-hdmi" ${p.hdmi ? 'checked' : ''}> 📡 HDMI-Taste (Sky-Box) anzeigen</label>
        <label><input type="checkbox" class="opt-forcetv" ${p.forceTv ? 'checked' : ''}> Vor Senderwahl auf TV-Tuner wechseln</label>
      </div>
    `;

    row.querySelector('.profile-color-dot').addEventListener('click', () => {
      const idx = PROFILE_COLORS.indexOf(p.color);
      p.color = PROFILE_COLORS[(idx + 1) % PROFILE_COLORS.length];
      saveProfiles(profiles);
      renderProfileEditor();
      applyProfile();
    });

    row.querySelector('.profile-name-input').addEventListener('change', (e) => {
      p.name = e.target.value.trim() || p.name;
      saveProfiles(profiles);
      renderProfileSwitch();
    });

    row.querySelector('.opt-headphones').addEventListener('change', (e) => {
      p.headphones = e.target.checked;
      saveProfiles(profiles);
      applyProfile();
    });

    row.querySelector('.opt-hdmi').addEventListener('change', (e) => {
      p.hdmi = e.target.checked;
      saveProfiles(profiles);
      applyProfile();
    });

    row.querySelector('.opt-forcetv').addEventListener('change', (e) => {
      p.forceTv = e.target.checked;
      saveProfiles(profiles);
    });

    row.querySelector('.profile-remove-btn').addEventListener('click', () => {
      if (profiles.length <= 1) return;
      profiles.splice(i, 1);
      saveProfiles(profiles);
      if (getActiveProfile() === p.id) {
        localStorage.setItem('tvProfile', profiles[0].id);
      }
      renderProfileEditor();
      applyProfile();
    });

    profileEditorEl.appendChild(row);
  });

  addProfileBtn.hidden = profiles.length >= MAX_PROFILES;
}

document.getElementById('openProfilesBtn').addEventListener('click', () => {
  settingsDialog.close();
  renderProfileEditor();
  profilesDialog.showModal();
});

document.getElementById('closeProfilesBtn').addEventListener('click', () => {
  profilesDialog.close();
});

addProfileBtn.addEventListener('click', () => {
  const profiles = getProfiles();
  if (profiles.length >= MAX_PROFILES) return;
  const usedColors = profiles.map((p) => p.color);
  const nextColor = PROFILE_COLORS.find((c) => !usedColors.includes(c)) || PROFILE_COLORS[0];
  profiles.push({
    id: `p${Date.now()}`,
    name: `Person ${profiles.length + 1}`,
    color: nextColor,
    headphones: false,
    hdmi: false,
    forceTv: false,
  });
  saveProfiles(profiles);
  renderProfileEditor();
});

function getFavorites() {
  try {
    return JSON.parse(localStorage.getItem(`tvFavorites_${getActiveProfile()}`) || '[]');
  } catch (e) {
    return [];
  }
}

function saveFavorites(favs) {
  localStorage.setItem(`tvFavorites_${getActiveProfile()}`, JSON.stringify(favs));
}

const favoritesListEl = document.getElementById('favoritesList');
const favoritesEditorEl = document.getElementById('favoritesEditor');
const favoritesDialog = document.getElementById('favoritesDialog');
const favNameInput = document.getElementById('favNameInput');
const favChannelInput = document.getElementById('favChannelInput');

function renderFavorites() {
  const favs = getFavorites();
  favoritesListEl.innerHTML = '';
  favs.forEach((fav) => {
    const btn = document.createElement('button');
    btn.className = 'fav-btn';
    btn.innerHTML = `<span>${fav.name}</span><span class="fav-channel">${fav.channel}</span>`;
    btn.addEventListener('click', () => sendChannel(fav.channel));
    favoritesListEl.appendChild(btn);
  });
}

function renderFavoritesEditor() {
  const favs = getFavorites();
  favoritesEditorEl.innerHTML = '';
  favs.forEach((fav, i) => {
    const row = document.createElement('div');
    row.className = 'fav-edit-row';
    row.innerHTML = `
      <div class="fav-edit-info">
        <div class="fav-edit-name">${fav.name}</div>
        <div class="fav-edit-channel">Kanal ${fav.channel}</div>
      </div>
      <button type="button" class="move-up" aria-label="Nach oben">↑</button>
      <button type="button" class="move-down" aria-label="Nach unten">↓</button>
      <button type="button" class="remove-fav" aria-label="Entfernen">✕</button>
    `;
    row.querySelector('.move-up').addEventListener('click', () => {
      if (i === 0) return;
      [favs[i - 1], favs[i]] = [favs[i], favs[i - 1]];
      saveFavorites(favs);
      renderFavoritesEditor();
      renderFavorites();
    });
    row.querySelector('.move-down').addEventListener('click', () => {
      if (i === favs.length - 1) return;
      [favs[i + 1], favs[i]] = [favs[i], favs[i + 1]];
      saveFavorites(favs);
      renderFavoritesEditor();
      renderFavorites();
    });
    row.querySelector('.remove-fav').addEventListener('click', () => {
      favs.splice(i, 1);
      saveFavorites(favs);
      renderFavoritesEditor();
      renderFavorites();
    });
    favoritesEditorEl.appendChild(row);
  });
}

const favoritesDialogTitle = document.getElementById('favoritesDialogTitle');

document.getElementById('favEditBtn').addEventListener('click', () => {
  favoritesDialogTitle.textContent = `Senderliste von ${getActiveProfileObj().name} bearbeiten`;
  renderFavoritesEditor();
  favoritesDialog.showModal();
});

document.getElementById('closeFavBtn').addEventListener('click', () => {
  favoritesDialog.close();
});

document.getElementById('addFavForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = favNameInput.value.trim();
  const channel = favChannelInput.value.trim().replace(/[^0-9]/g, '');
  if (!name || !channel) return;
  const favs = getFavorites();
  favs.push({ name, channel });
  saveFavorites(favs);
  favNameInput.value = '';
  favChannelInput.value = '';
  renderFavoritesEditor();
  renderFavorites();
  favNameInput.focus();
});

applyProfile();

if (!getTvIp()) {
  settingsDialog.showModal();
} else {
  setStatus('nicht verbunden');
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
