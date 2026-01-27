/**
 * Pi-Browser Web Client
 * 멀티 브라우저 제어 웹 UI + 텔레그램 설정
 */

import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// 설정 파일 경로
const CONFIG_DIR = path.join(os.homedir(), ".pi-browser");
const SETTINGS_PATH = path.join(CONFIG_DIR, "settings.json");

export interface Settings {
  telegram?: {
    botToken?: string;
    allowedUsers?: number[];
    enabled?: boolean;
    profile?: string; // 텔레그램에서 사용할 Chrome 프로필 경로
  };
  ai?: {
    provider?: string;
    model?: string;
    ollamaUrl?: string;
  };
  browser?: {
    mode?: "cdp" | "extension";
    reuseExisting?: boolean;
    multiProfile?: boolean;
    headless?: boolean;
    profilePath?: string;
    selectedProfile?: string; // 프로필 경로
  };
  notion?: {
    enabled?: boolean;
    apiKey?: string;
    databaseId?: string;
  };
}

export interface ChromeProfile {
  name: string;
  path: string;
  displayName: string;
}

export function loadSettings(): Settings {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    }
  } catch {}
  return {};
}

export function saveSettings(settings: Settings): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// Chrome 프로필 디렉토리 경로
function getChromeProfilesDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
  } else if (process.platform === "win32") {
    return path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "User Data");
  }
  return path.join(os.homedir(), ".config", "google-chrome");
}

// Chrome 프로필 스캔
export function scanChromeProfiles(): ChromeProfile[] {
  const profiles: ChromeProfile[] = [];
  const chromeDir = getChromeProfilesDir();

  // Pi-Browser 전용 프로필
  const piBrowserProfile = path.join(os.homedir(), ".pi-browser", "chrome-profile");
  profiles.push({
    name: "pi-browser",
    path: piBrowserProfile,
    displayName: "🤖 Pi-Browser (기본)",
  });

  if (!fs.existsSync(chromeDir)) {
    return profiles;
  }

  try {
    const entries = fs.readdirSync(chromeDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Default 프로필 또는 Profile N 형식
      if (entry.name === "Default" || entry.name.startsWith("Profile ")) {
        const profilePath = path.join(chromeDir, entry.name);
        const prefsPath = path.join(profilePath, "Preferences");

        let displayName = entry.name;

        if (fs.existsSync(prefsPath)) {
          try {
            const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
            if (prefs.profile?.name) {
              displayName = prefs.profile.name;
            }
          } catch {}
        }

        profiles.push({
          name: entry.name,
          path: profilePath,
          displayName: `👤 ${displayName}`,
        });
      }
    }
  } catch (e) {
    console.error("[WebClient] Chrome 프로필 스캔 오류:", e);
  }

  return profiles;
}

const HTML_PAGE = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pi-Browser Control</title>
  <style>
    @keyframes glow { 0%,100%{text-shadow:0 0 10px #00d9ff,0 0 20px #00d9ff;} 50%{text-shadow:0 0 20px #00d9ff,0 0 40px #00d9ff,0 0 60px #0077ff;} }
    @keyframes pulse { 0%,100%{opacity:1;} 50%{opacity:0.7;} }
    @keyframes scanline { 0%{transform:translateY(-100%);} 100%{transform:translateY(100%);} }
    @keyframes borderGlow { 0%,100%{border-color:#00d9ff;box-shadow:0 0 5px #00d9ff;} 50%{border-color:#ff00ff;box-shadow:0 0 15px #ff00ff;} }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Courier New', monospace;
      background: linear-gradient(135deg, #0a0a1a 0%, #1a1a3e 50%, #0a0a2a 100%);
      color: #eee;
      min-height: 100vh;
      padding: 20px;
      position: relative;
      overflow-x: hidden;
    }
    body::before {
      content: '';
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,217,255,0.03) 2px, rgba(0,217,255,0.03) 4px);
      pointer-events: none;
      z-index: 1000;
    }
    .container { max-width: 1400px; margin: 0 auto; position: relative; z-index: 1; }
    h1 {
      text-align: center;
      margin-bottom: 30px;
      color: #00d9ff;
      font-size: 32px;
      font-weight: bold;
      letter-spacing: 4px;
      text-transform: uppercase;
      animation: glow 3s ease-in-out infinite;
    }
    h1::before { content: '[ '; color: #ff00ff; }
    h1::after { content: ' ]'; color: #ff00ff; }

    /* 탭 네비게이션 */
    .tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 30px;
      border-bottom: 1px solid rgba(0,217,255,0.3);
      padding-bottom: 0;
    }
    .tab {
      padding: 14px 28px;
      background: transparent;
      border: 1px solid transparent;
      border-bottom: none;
      color: #666;
      cursor: pointer;
      font-size: 13px;
      letter-spacing: 2px;
      text-transform: uppercase;
      transition: all 0.3s;
      position: relative;
      clip-path: polygon(10px 0, 100% 0, 100% 100%, 0 100%, 0 10px);
    }
    .tab:hover { color: #00d9ff; background: rgba(0,217,255,0.1); }
    .tab.active {
      color: #00d9ff;
      background: rgba(0,217,255,0.15);
      border-color: rgba(0,217,255,0.5);
      box-shadow: 0 0 20px rgba(0,217,255,0.2);
    }
    .tab-content { display: none; }
    .tab-content.active { display: block; animation: fadeIn 0.3s ease; }
    @keyframes fadeIn { from{opacity:0;transform:translateY(10px);} to{opacity:1;transform:translateY(0);} }

    /* 입력 영역 */
    .input-area {
      display: flex;
      gap: 12px;
      margin-bottom: 25px;
    }
    input[type="text"], input[type="password"], .cyber-select {
      padding: 14px 18px;
      font-size: 14px;
      font-family: 'Courier New', monospace;
      border: 1px solid rgba(0,217,255,0.3);
      border-radius: 0;
      background: rgba(10,10,30,0.8);
      color: #00d9ff;
      outline: none;
      transition: all 0.3s;
      clip-path: polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px);
    }
    input:focus, .cyber-select:focus {
      border-color: #00d9ff;
      box-shadow: 0 0 15px rgba(0,217,255,0.3), inset 0 0 15px rgba(0,217,255,0.1);
    }
    #taskInput { flex: 1; font-size: 16px; }
    ::placeholder { color: #446; }

    button {
      padding: 14px 28px;
      font-size: 13px;
      font-family: 'Courier New', monospace;
      letter-spacing: 1px;
      text-transform: uppercase;
      border: 1px solid;
      clip-path: polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px);
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-primary {
      background: linear-gradient(135deg, rgba(0,217,255,0.8), rgba(0,119,255,0.8));
      border-color: #00d9ff;
      color: white;
    }
    .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 0 25px rgba(0,217,255,0.5), 0 4px 15px rgba(0,217,255,0.3); }
    .btn-secondary { background: rgba(68,68,68,0.8); border-color: #666; color: white; }
    .btn-secondary:hover { background: rgba(85,85,85,0.8); box-shadow: 0 0 15px rgba(255,255,255,0.1); }
    .btn-sm { padding: 6px 12px; font-size: 10px; margin-left: 10px; vertical-align: middle; }
    .btn-danger { background: rgba(231,76,60,0.8); border-color: #e74c3c; color: white; }
    .btn-danger:hover { background: rgba(192,57,43,0.9); box-shadow: 0 0 20px rgba(231,76,60,0.4); }
    .btn-success { background: rgba(39,174,96,0.8); border-color: #27ae60; color: white; }
    .btn-success:hover { background: rgba(34,153,84,0.9); box-shadow: 0 0 20px rgba(39,174,96,0.4); }

    /* 작업 그리드 */
    .tasks-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
      gap: 20px;
    }
    .task-card {
      background: rgba(10,10,30,0.9);
      padding: 20px;
      border: 1px solid rgba(0,217,255,0.2);
      position: relative;
      clip-path: polygon(15px 0, 100% 0, 100% calc(100% - 15px), calc(100% - 15px) 100%, 0 100%, 0 15px);
      transition: all 0.3s;
    }
    .task-card::before {
      content: '';
      position: absolute;
      top: 0; left: 0;
      width: 100%; height: 2px;
      background: linear-gradient(90deg, transparent, #00d9ff, transparent);
      animation: scanline 2s linear infinite;
    }
    .task-card:hover {
      border-color: rgba(0,217,255,0.5);
      box-shadow: 0 0 30px rgba(0,217,255,0.15);
    }
    .task-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
      padding-bottom: 10px;
      border-bottom: 1px solid rgba(0,217,255,0.1);
    }
    .task-id {
      font-size: 11px;
      color: #00d9ff;
      font-family: 'Courier New', monospace;
      letter-spacing: 1px;
    }
    .task-status {
      padding: 5px 14px;
      font-size: 10px;
      font-weight: bold;
      letter-spacing: 1px;
      text-transform: uppercase;
      clip-path: polygon(5px 0, 100% 0, calc(100% - 5px) 100%, 0 100%);
    }
    .status-pending { background: linear-gradient(135deg, #f39c12, #e67e22); color: #000; }
    .status-running { background: linear-gradient(135deg, #00d9ff, #0077ff); color: #fff; animation: pulse 1.5s infinite; }
    .status-done { background: linear-gradient(135deg, #27ae60, #2ecc71); color: #fff; }
    .status-error { background: linear-gradient(135deg, #e74c3c, #c0392b); color: #fff; }
    .status-stopped { background: linear-gradient(135deg, #95a5a6, #7f8c8d); color: #fff; }

    .task-actions { display: flex; align-items: center; gap: 10px; }
    .btn-stop, .btn-delete {
      width: 30px; height: 30px;
      border: 1px solid;
      cursor: pointer; font-size: 12px;
      display: flex; align-items: center; justify-content: center;
      clip-path: polygon(5px 0, 100% 0, 100% calc(100% - 5px), calc(100% - 5px) 100%, 0 100%, 0 5px);
      transition: all 0.2s;
    }
    .btn-stop { background: rgba(231,76,60,0.8); border-color: #e74c3c; }
    .btn-stop:hover { box-shadow: 0 0 15px rgba(231,76,60,0.5); }
    .btn-delete { background: rgba(127,140,141,0.8); border-color: #7f8c8d; }
    .btn-delete:hover { box-shadow: 0 0 15px rgba(127,140,141,0.5); }

    .task-mission {
      font-size: 13px;
      color: #00d9ff;
      margin-bottom: 15px;
      padding: 12px;
      background: rgba(0,217,255,0.05);
      border-left: 2px solid #00d9ff;
      font-family: 'Courier New', monospace;
    }
    .task-log {
      font-family: 'Courier New', monospace;
      font-size: 11px;
      background: rgba(0,0,0,0.5);
      padding: 15px;
      max-height: 200px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
      border: 1px solid rgba(0,217,255,0.1);
      color: #0f0;
    }
    .task-log::-webkit-scrollbar { width: 6px; }
    .task-log::-webkit-scrollbar-track { background: rgba(0,0,0,0.3); }
    .task-log::-webkit-scrollbar-thumb { background: #00d9ff; }
    .task-result {
      margin-top: 15px;
      padding: 15px;
      background: rgba(39,174,96,0.1);
      border: 1px solid rgba(39,174,96,0.3);
      border-left: 3px solid #27ae60;
      color: #2ecc71;
    }
    .log-tool { color: #f39c12; }
    .log-success { color: #2ecc71; }
    .log-error { color: #e74c3c; }

    /* 통계 */
    .stats {
      display: flex;
      gap: 25px;
      margin-bottom: 25px;
      padding: 20px 25px;
      background: rgba(10,10,30,0.8);
      border: 1px solid rgba(0,217,255,0.2);
      clip-path: polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px);
    }
    .stat { text-align: center; padding: 0 15px; border-right: 1px solid rgba(0,217,255,0.1); }
    .stat:last-child { border-right: none; }
    .stat-value {
      font-size: 28px;
      font-weight: bold;
      color: #00d9ff;
      font-family: 'Courier New', monospace;
      text-shadow: 0 0 10px rgba(0,217,255,0.5);
    }
    .stat-label { font-size: 10px; color: #666; letter-spacing: 2px; text-transform: uppercase; margin-top: 5px; }
    .connected { color: #2ecc71; text-shadow: 0 0 10px rgba(46,204,113,0.5); }
    .disconnected { color: #e74c3c; text-shadow: 0 0 10px rgba(231,76,60,0.5); animation: pulse 1s infinite; }

    /* 설정 패널 */
    .settings-section {
      background: #16213e;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 20px;
    }
    .settings-section h3 {
      color: #00d9ff;
      margin-bottom: 16px;
      font-size: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .form-group {
      margin-bottom: 16px;
    }
    .form-group label {
      display: block;
      margin-bottom: 8px;
      color: #aaa;
      font-size: 13px;
    }
    .form-group input {
      width: 100%;
      max-width: 500px;
    }
    .form-group small {
      display: block;
      margin-top: 6px;
      color: #666;
      font-size: 12px;
    }
    .toggle-group {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .toggle {
      position: relative;
      width: 50px;
      height: 26px;
    }
    .toggle input {
      opacity: 0;
      width: 0;
      height: 0;
    }
    .toggle-slider {
      position: absolute;
      cursor: pointer;
      top: 0; left: 0; right: 0; bottom: 0;
      background-color: #444;
      border-radius: 26px;
      transition: 0.3s;
    }
    .toggle-slider:before {
      position: absolute;
      content: "";
      height: 20px;
      width: 20px;
      left: 3px;
      bottom: 3px;
      background-color: white;
      border-radius: 50%;
      transition: 0.3s;
    }
    .toggle input:checked + .toggle-slider {
      background-color: #27ae60;
    }
    .toggle input:checked + .toggle-slider:before {
      transform: translateX(24px);
    }
    .status-badge {
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 12px;
    }
    .status-badge.running { background: #27ae60; color: white; }
    .status-badge.stopped { background: #e74c3c; color: white; }

    #settingsAlert {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 9999;
      min-width: 300px;
      max-width: 500px;
    }
    .alert {
      padding: 14px 24px;
      border-radius: 8px;
      font-size: 14px;
      text-align: center;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      animation: slideUp 0.3s ease;
    }
    @keyframes slideUp {
      from { transform: translateY(20px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
    .alert-success { background: #1a3a1a; border: 2px solid #27ae60; color: #2ecc71; }
    .alert-error { background: #3a1a1a; border: 2px solid #e74c3c; color: #e74c3c; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🤖 Pi-Browser Control</h1>

    <div class="tabs">
      <button class="tab active" onclick="showTab('tasks')">📋 작업</button>
      <button class="tab" onclick="showTab('settings')">⚙️ 설정</button>
    </div>

    <!-- 작업 탭 -->
    <div id="tab-tasks" class="tab-content active">
      <div class="stats">
        <div class="stat">
          <div class="stat-value" id="totalTasks">0</div>
          <div class="stat-label">전체</div>
        </div>
        <div class="stat">
          <div class="stat-value" id="runningTasks">0</div>
          <div class="stat-label">실행중</div>
        </div>
        <div class="stat">
          <div class="stat-value" id="doneTasks">0</div>
          <div class="stat-label">완료</div>
        </div>
        <div class="stat">
          <div id="connectionStatus" class="disconnected">● 연결 안됨</div>
          <div class="stat-label">서버</div>
        </div>
        <div class="stat">
          <div id="extensionStatus" class="disconnected">● 꺼짐</div>
          <div class="stat-label">Extension</div>
        </div>
        <div class="stat">
          <div id="telegramStatus" class="disconnected">● 꺼짐</div>
          <div class="stat-label">텔레그램</div>
        </div>
      </div>

      <div class="input-area">
        <select id="taskProfile" class="cyber-select" style="width:200px;">
          <option value="">🔄 프로필 로딩...</option>
        </select>
        <input type="text" id="taskInput" placeholder="명령 입력 (예: 네이버에서 날씨 알려줘)" autocomplete="off" />
        <button class="btn-primary" onclick="addTask()">▶ 실행</button>
        <button class="btn-danger" onclick="clearDone()">🗑 완료 삭제</button>
      </div>

      <div class="tasks-grid" id="tasksGrid"></div>
    </div>

    <!-- 설정 탭 -->
    <div id="tab-settings" class="tab-content">
      <div id="settingsAlert"></div>

      <div class="settings-section">
        <h3>🤖 텔레그램 봇</h3>

        <div class="form-group">
          <div class="toggle-group">
            <label class="toggle">
              <input type="checkbox" id="telegramEnabled" onchange="updateTelegramToggle()">
              <span class="toggle-slider"></span>
            </label>
            <span>텔레그램 봇 활성화</span>
            <span id="telegramStatusBadge" class="status-badge stopped">중지됨</span>
          </div>
        </div>

        <div class="form-group">
          <label>Bot Token</label>
          <input type="text" id="telegramToken" placeholder="123456789:ABCdefGHI..." autocomplete="off" data-lpignore="true" style="-webkit-text-security:disc;" />
          <small>@BotFather에서 받은 토큰</small>
        </div>

        <div class="form-group">
          <label>허용된 사용자 ID (선택)</label>
          <input type="text" id="telegramUsers" placeholder="123456789, 987654321" />
          <small>⚠️ 필수! 비워두면 아무도 사용 불가. 여러 ID는 쉼표로 구분</small>
        </div>

        <div class="form-group">
          <label>Chrome 프로필 <button class="btn-sm" onclick="refreshProfiles()">🔄</button></label>
          <select id="telegramProfile" class="cyber-select" style="max-width:500px;width:100%;">
            <option value="">🔄 로딩...</option>
          </select>
          <small>텔레그램에서 실행할 때 사용할 Chrome 프로필</small>
        </div>

        <button class="btn-primary" onclick="saveTelegramSettings()">💾 저장</button>
        <button class="btn-secondary" onclick="testTelegram()">🧪 테스트</button>
      </div>

      <div class="settings-section">
        <h3>🧠 AI 모델 <span id="aiStatusBadge" class="status-badge" style="display:none;"></span></h3>

        <div class="form-group">
          <label>Provider</label>
          <select id="aiProvider" class="cyber-select" style="max-width:500px;width:100%;" onchange="toggleOllamaSettings()">
            <option value="google">Google (Gemini)</option>
            <option value="openai">OpenAI (GPT)</option>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="groq">Groq</option>
            <option value="ollama">Ollama (로컬)</option>
          </select>
        </div>

        <div class="form-group">
          <label>Model</label>
          <select id="aiModel" class="cyber-select" style="max-width:500px;width:100%;">
            <option value="gemini-2.0-flash">gemini-2.0-flash</option>
          </select>
        </div>

        <div id="ollamaSettings" style="display:none;">
          <div class="form-group" style="background:rgba(255,165,0,0.2);padding:20px;border-radius:8px;margin-bottom:16px;border:2px solid #f90;">
            <h4 style="color:#f90;margin-bottom:15px;">🦙 Ollama 로컬 AI</h4>
            <div style="display:flex;align-items:center;gap:15px;margin-bottom:15px;flex-wrap:wrap;">
              <span id="ollamaStatusIcon" style="font-size:24px;">⚪</span>
              <span id="ollamaStatusText" style="color:#888;font-size:14px;">연결 상태 확인 필요</span>
              <button class="btn-primary" onclick="testOllama()" style="padding:10px 20px;">🔌 연결 테스트</button>
            </div>
            <div style="margin-bottom:15px;">
              <label style="display:block;margin-bottom:5px;color:#aaa;">Ollama 서버 URL</label>
              <input type="text" id="ollamaUrl" value="http://localhost:11434" style="width:100%;max-width:400px;" />
            </div>
            <div>
              <label style="display:block;margin-bottom:5px;color:#aaa;">설치된 모델</label>
              <select id="ollamaModels" class="cyber-select" style="max-width:400px;width:100%;" onchange="selectOllamaModel()">
                <option value="">🔌 연결 테스트를 먼저 하세요</option>
              </select>
            </div>
          </div>
        </div>

        <button class="btn-primary" onclick="saveAISettings()">💾 저장</button>
      </div>

      <div class="settings-section">
        <h3>🌐 브라우저</h3>

        <div class="form-group">
          <label>실행 모드</label>
          <select id="browserMode" class="cyber-select">
            <option value="cdp">🖥️ CDP 모드 (새 Chrome 실행)</option>
            <option value="extension">🔌 Extension 모드 (기존 Chrome 연결)</option>
          </select>
          <small>CDP: 새 브라우저 창 / Extension: 기존 브라우저에 확장 연결</small>
        </div>

        <div class="form-group">
          <label>Chrome 프로필 <button class="btn-sm" onclick="refreshProfiles()">🔄 새로고침</button></label>
          <select id="browserProfile" class="cyber-select">
            <option value="">로딩 중...</option>
          </select>
          <small>로그인 상태, 쿠키, 확장 프로그램이 유지되는 프로필 선택</small>
        </div>

        <div class="form-group">
          <div class="toggle-group">
            <label class="toggle">
              <input type="checkbox" id="browserReuse">
              <span class="toggle-slider"></span>
            </label>
            <span>기존 브라우저 재사용</span>
          </div>
          <small>활성화 시 이미 실행 중인 브라우저를 재사용합니다</small>
        </div>

        <div class="form-group">
          <div class="toggle-group">
            <label class="toggle">
              <input type="checkbox" id="browserHeadless">
              <span class="toggle-slider"></span>
            </label>
            <span>Headless 모드</span>
          </div>
          <small>브라우저 창 없이 백그라운드 실행 (CDP 모드만)</small>
        </div>

        <div class="form-group">
          <div class="toggle-group">
            <label class="toggle">
              <input type="checkbox" id="browserMultiProfile">
              <span class="toggle-slider"></span>
            </label>
            <span>멀티 프로필</span>
          </div>
          <small>각 작업마다 독립적인 프로필 사용</small>
        </div>

        <div class="form-group">
          <label>프로필 경로 (선택)</label>
          <input type="text" id="browserProfilePath" placeholder="~/.pi-browser/chrome-profile" />
          <small>Chrome 프로필 저장 위치 (로그인 상태 유지)</small>
        </div>

        <button class="btn-primary" onclick="saveBrowserSettings()">💾 저장</button>
      </div>

      <div class="settings-section">
        <h3>📝 Notion 연동</h3>

        <div class="form-group">
          <div class="toggle-group">
            <label class="toggle">
              <input type="checkbox" id="notionEnabled" onchange="updateNotionToggle()">
              <span class="toggle-slider"></span>
            </label>
            <span>Notion 저장 활성화</span>
            <span id="notionStatusBadge" class="status-badge stopped">비활성</span>
          </div>
        </div>

        <div class="form-group">
          <label>Integration Token (API Key)</label>
          <input type="text" id="notionApiKey" placeholder="secret_xxxxxxxxxxxx..." autocomplete="off" data-lpignore="true" style="-webkit-text-security:disc;" />
          <small><a href="https://www.notion.so/my-integrations" target="_blank" style="color:#00d9ff;">notion.so/my-integrations</a>에서 발급</small>
        </div>

        <div class="form-group">
          <label>Database ID</label>
          <input type="text" id="notionDatabaseId" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" autocomplete="off" />
          <small>노션 데이터베이스 URL에서 복사 (예: notion.so/[Database ID]?v=...)</small>
        </div>

        <button class="btn-primary" onclick="saveNotionSettings()">💾 저장</button>
        <button class="btn-secondary" onclick="testNotion()">🧪 연결 테스트</button>
        <button class="btn-success" onclick="openNotion()">🔗 Notion 열기</button>
      </div>
    </div>
  </div>

  <script>
    let ws;
    let tasks = new Map();
    let taskIdCounter = 0;
    let settings = {};

    function showTab(tabId) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      document.querySelector(\`[onclick="showTab('\${tabId}')"]\`).classList.add('active');
      document.getElementById('tab-' + tabId).classList.add('active');
    }

    function connect() {
      ws = new WebSocket('ws://' + location.host + '/ws');

      ws.onopen = () => {
        document.getElementById('connectionStatus').className = 'connected';
        document.getElementById('connectionStatus').textContent = '● 연결됨';
        ws.send(JSON.stringify({ type: 'getSettings' }));
        ws.send(JSON.stringify({ type: 'getProfiles' }));
        // 초기 모델 목록 표시
        toggleOllamaSettings();
      };

      ws.onclose = () => {
        document.getElementById('connectionStatus').className = 'disconnected';
        document.getElementById('connectionStatus').textContent = '● 연결 안됨';
        setTimeout(connect, 3000);
      };

      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        handleMessage(msg);
      };
    }

    let profiles = [];

    function handleMessage(msg) {
      console.log('handleMessage:', msg.type);
      if (msg.type === 'settings') {
        settings = msg.settings || {};
        applySettings();
        return;
      }

      if (msg.type === 'profiles') {
        profiles = msg.profiles || [];
        updateProfileSelect();
        return;
      }

      if (msg.type === 'telegramStatus') {
        updateTelegramStatus(msg.running);
        return;
      }

      if (msg.type === 'extensionStatus') {
        updateExtensionStatus(msg.connected);
        return;
      }

      if (msg.type === 'alert') {
        showAlert(msg.success, msg.message);
        return;
      }

      if (msg.type === 'ollamaStatus') {
        updateOllamaStatus(msg.connected, msg.message);
        if (msg.connected && msg.models) {
          updateOllamaModels(msg.models);
          showAlert(true, '✅ Ollama 연결 성공! ' + msg.models.length + '개 모델');
        } else if (!msg.connected) {
          showAlert(false, '❌ Ollama: ' + msg.message);
        }
        return;
      }

      // 텔레그램에서 새 작업 생성
      if (msg.type === 'newTask') {
        const task = {
          id: msg.taskId,
          mission: msg.mission,
          source: msg.source || 'telegram',
          status: 'running',
          logs: [],
          result: null
        };
        tasks.set(msg.taskId, task);
        renderTaskCard(task);
        updateStats();
        return;
      }

      const task = tasks.get(msg.taskId);
      if (!task) return;

      if (msg.type === 'log') {
        task.logs.push(msg.text);
        updateTaskCard(msg.taskId);
      } else if (msg.type === 'status') {
        task.status = msg.status;
        updateTaskCard(msg.taskId);
        updateStats();
      } else if (msg.type === 'result') {
        task.result = msg.text;
        task.status = 'done';
        updateTaskCard(msg.taskId);
        updateStats();
      } else if (msg.type === 'error') {
        task.logs.push('[ERROR] ' + msg.text);
        task.status = 'error';
        updateTaskCard(msg.taskId);
        updateStats();
      }
    }

    function applySettings() {
      if (settings.telegram) {
        document.getElementById('telegramEnabled').checked = settings.telegram.enabled || false;
        document.getElementById('telegramToken').value = settings.telegram.botToken || '';
        document.getElementById('telegramUsers').value = (settings.telegram.allowedUsers || []).join(', ');
        if (settings.telegram.profile) {
          setTimeout(() => {
            document.getElementById('telegramProfile').value = settings.telegram.profile;
          }, 100);
        }
      }
      if (settings.ai) {
        document.getElementById('aiProvider').value = settings.ai.provider || 'google';
        document.getElementById('ollamaUrl').value = settings.ai.ollamaUrl || 'http://localhost:11434';
        // 모델 목록 업데이트 후 값 설정
        toggleOllamaSettings();
        if (settings.ai.provider === 'ollama') {
          // Ollama는 연결 후 모델 목록 가져옴
          setTimeout(() => fetchOllamaModels(), 200);
        } else {
          // 다른 프로바이더는 저장된 모델이 유효한 경우에만 선택
          setTimeout(() => {
            const modelSelect = document.getElementById('aiModel');
            const savedModel = settings.ai.model;
            // 저장된 모델이 현재 프로바이더의 모델 목록에 있는지 확인
            if (savedModel && Array.from(modelSelect.options).some(o => o.value === savedModel)) {
              modelSelect.value = savedModel;
            }
            // 없으면 첫 번째 모델이 자동 선택됨
          }, 50);
        }
      }
      if (settings.browser) {
        document.getElementById('browserMode').value = settings.browser.mode || 'cdp';
        document.getElementById('browserReuse').checked = settings.browser.reuseExisting || false;
        document.getElementById('browserHeadless').checked = settings.browser.headless || false;
        document.getElementById('browserMultiProfile').checked = settings.browser.multiProfile || false;
        document.getElementById('browserProfilePath').value = settings.browser.profilePath || '';
        // 프로필 선택 (프로필 목록이 로드된 후 적용)
        if (settings.browser.selectedProfile) {
          setTimeout(() => {
            document.getElementById('browserProfile').value = settings.browser.selectedProfile;
          }, 100);
        }
      }
      if (settings.notion) {
        document.getElementById('notionEnabled').checked = settings.notion.enabled || false;
        document.getElementById('notionApiKey').value = settings.notion.apiKey || '';
        document.getElementById('notionDatabaseId').value = settings.notion.databaseId || '';
        updateNotionToggle();
      }
    }

    function updateProfileSelect() {
      // 설정 탭의 브라우저 프로필
      const browserSelect = document.getElementById('browserProfile');
      browserSelect.innerHTML = '';
      profiles.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.path;
        opt.textContent = p.displayName;
        browserSelect.appendChild(opt);
      });

      // 작업 탭의 프로필 선택기
      const taskSelect = document.getElementById('taskProfile');
      taskSelect.innerHTML = '';
      profiles.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.path;
        opt.textContent = p.displayName;
        taskSelect.appendChild(opt);
      });

      // 텔레그램 프로필 선택기
      const telegramSelect = document.getElementById('telegramProfile');
      telegramSelect.innerHTML = '';
      profiles.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.path;
        opt.textContent = p.displayName;
        telegramSelect.appendChild(opt);
      });

      // 저장된 프로필 적용
      if (settings.browser?.selectedProfile) {
        browserSelect.value = settings.browser.selectedProfile;
        taskSelect.value = settings.browser.selectedProfile;
      }
      if (settings.telegram?.profile) {
        telegramSelect.value = settings.telegram.profile;
      }
    }

    function refreshProfiles() {
      ws.send(JSON.stringify({ type: 'getProfiles' }));
    }

    function updateTelegramStatus(running) {
      const el = document.getElementById('telegramStatus');
      const badge = document.getElementById('telegramStatusBadge');
      if (running) {
        el.className = 'connected';
        el.textContent = '● 실행중';
        badge.className = 'status-badge running';
        badge.textContent = '실행중';
      } else {
        el.className = 'disconnected';
        el.textContent = '● 꺼짐';
        badge.className = 'status-badge stopped';
        badge.textContent = '중지됨';
      }
    }

    function updateExtensionStatus(connected) {
      const el = document.getElementById('extensionStatus');
      if (connected) {
        el.className = 'connected';
        el.textContent = '● 연결됨';
      } else {
        el.className = 'disconnected';
        el.textContent = '● 꺼짐';
      }
    }

    function updateTelegramToggle() {
      const enabled = document.getElementById('telegramEnabled').checked;
      ws.send(JSON.stringify({ type: 'toggleTelegram', enabled }));
    }

    function saveTelegramSettings() {
      const token = document.getElementById('telegramToken').value.trim();
      const usersStr = document.getElementById('telegramUsers').value.trim();
      const users = usersStr ? usersStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n)) : [];
      const enabled = document.getElementById('telegramEnabled').checked;
      const profile = document.getElementById('telegramProfile').value;

      ws.send(JSON.stringify({
        type: 'saveTelegram',
        settings: { botToken: token, allowedUsers: users, enabled, profile }
      }));
    }

    function testTelegram() {
      const token = document.getElementById('telegramToken').value.trim();
      ws.send(JSON.stringify({ type: 'testTelegram', token }));
    }

    function saveAISettings() {
      const provider = document.getElementById('aiProvider').value;
      const model = document.getElementById('aiModel').value;
      const ollamaUrl = document.getElementById('ollamaUrl').value.trim() || 'http://localhost:11434';

      ws.send(JSON.stringify({
        type: 'saveAI',
        settings: { provider, model, ollamaUrl }
      }));
    }

    // 프로바이더별 모델 목록 (pi-ai에서 가져온 최신 목록)
    const providerModels = {
      google: [
        { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (추천) [R]' },
        { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro [R]' },
        { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
        { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview [R]' },
        { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview [R]' },
        { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
        { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
      ],
      openai: [
        { value: 'gpt-4o', label: 'GPT-4o (추천)' },
        { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
        { value: 'gpt-4.1', label: 'GPT-4.1' },
        { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
        { value: 'gpt-5', label: 'GPT-5 [R]' },
        { value: 'gpt-5.1', label: 'GPT-5.1 [R]' },
        { value: 'gpt-5.2', label: 'GPT-5.2 [R]' },
        { value: 'o3-mini', label: 'o3-mini [R]' },
        { value: 'o4-mini', label: 'o4-mini [R]' },
      ],
      anthropic: [
        { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (추천) [R]' },
        { value: 'claude-opus-4-5', label: 'Claude Opus 4.5 [R]' },
        { value: 'claude-sonnet-4-0', label: 'Claude Sonnet 4 [R]' },
        { value: 'claude-opus-4-0', label: 'Claude Opus 4 [R]' },
        { value: 'claude-opus-4-1', label: 'Claude Opus 4.1 [R]' },
        { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 [R]' },
        { value: 'claude-3-7-sonnet-latest', label: 'Claude Sonnet 3.7 [R]' },
        { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet v2' },
        { value: 'claude-3-5-haiku-latest', label: 'Claude 3.5 Haiku' },
      ],
      groq: [
        { value: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (추천)' },
        { value: 'meta-llama/llama-4-maverick-17b-128e-instruct', label: 'Llama 4 Maverick 17B' },
        { value: 'meta-llama/llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout 17B' },
        { value: 'deepseek-r1-distill-llama-70b', label: 'DeepSeek R1 Distill 70B [R]' },
        { value: 'qwen-qwq-32b', label: 'Qwen QwQ 32B [R]' },
        { value: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B' },
      ],
      ollama: []  // Ollama는 동적으로 가져옴
    };

    function toggleOllamaSettings() {
      const provider = document.getElementById('aiProvider').value;
      const ollamaSettings = document.getElementById('ollamaSettings');
      const modelSelect = document.getElementById('aiModel');

      // Ollama 설정 표시/숨김
      if (provider === 'ollama') {
        ollamaSettings.style.display = 'block';
        testOllama();
      } else {
        ollamaSettings.style.display = 'none';
      }

      // 모델 드롭다운 업데이트
      const models = providerModels[provider] || [];
      const currentValue = modelSelect.value;

      if (provider === 'ollama') {
        // Ollama는 모델 목록이 동적으로 로드됨
        modelSelect.innerHTML = '<option value="">🔌 Ollama 연결 후 선택...</option>';
      } else {
        modelSelect.innerHTML = '';
        models.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m.value;
          opt.textContent = m.label;
          modelSelect.appendChild(opt);
        });
        // 이전 값 유지 (있으면)
        if (currentValue && Array.from(modelSelect.options).some(o => o.value === currentValue)) {
          modelSelect.value = currentValue;
        }
      }
    }

    function updateOllamaStatus(connected, message) {
      const icon = document.getElementById('ollamaStatusIcon');
      const text = document.getElementById('ollamaStatusText');
      if (connected) {
        icon.textContent = '🟢';
        text.textContent = message || '연결됨';
        text.style.color = '#2ecc71';
      } else {
        icon.textContent = '🔴';
        text.textContent = message || '연결 안됨';
        text.style.color = '#e74c3c';
      }
    }

    function testOllama() {
      const url = document.getElementById('ollamaUrl').value.trim() || 'http://localhost:11434';
      const icon = document.getElementById('ollamaStatusIcon');
      const text = document.getElementById('ollamaStatusText');

      icon.textContent = '🟡';
      text.textContent = '연결 중...';
      text.style.color = '#f39c12';

      ws.send(JSON.stringify({ type: 'testOllama', url }));
    }

    function updateOllamaModels(models) {
      const select = document.getElementById('ollamaModels');
      const modelSelect = document.getElementById('aiModel');
      const currentModel = settings.ai?.model || '';

      select.innerHTML = '';
      modelSelect.innerHTML = '';

      if (!models || models.length === 0) {
        select.innerHTML = '<option value="">설치된 모델 없음</option>';
        modelSelect.innerHTML = '<option value="">설치된 모델 없음</option>';
      } else {
        models.forEach(m => {
          // Ollama 모델 드롭다운
          const opt1 = document.createElement('option');
          opt1.value = m.name;
          opt1.textContent = m.name + (m.size ? ' (' + m.size + ')' : '');
          select.appendChild(opt1);

          // 메인 모델 드롭다운
          const opt2 = document.createElement('option');
          opt2.value = m.name;
          opt2.textContent = m.name + (m.size ? ' (' + m.size + ')' : '');
          modelSelect.appendChild(opt2);
        });

        // 현재 설정된 모델 선택
        if (currentModel && Array.from(select.options).some(o => o.value === currentModel)) {
          select.value = currentModel;
          modelSelect.value = currentModel;
        }
      }
    }

    function fetchOllamaModels() {
      testOllama();
    }

    function selectOllamaModel() {
      const modelSelect = document.getElementById('ollamaModels');
      const modelInput = document.getElementById('aiModel');
      if (modelSelect.value) {
        modelInput.value = modelSelect.value;
      }
    }

    function saveBrowserSettings() {
      const mode = document.getElementById('browserMode').value;
      const reuseExisting = document.getElementById('browserReuse').checked;
      const headless = document.getElementById('browserHeadless').checked;
      const multiProfile = document.getElementById('browserMultiProfile').checked;
      const profilePath = document.getElementById('browserProfilePath').value.trim();
      const selectedProfile = document.getElementById('browserProfile').value;

      ws.send(JSON.stringify({
        type: 'saveBrowser',
        settings: { mode, reuseExisting, headless, multiProfile, profilePath, selectedProfile }
      }));
    }

    function updateNotionToggle() {
      const enabled = document.getElementById('notionEnabled').checked;
      const badge = document.getElementById('notionStatusBadge');
      badge.textContent = enabled ? '활성' : '비활성';
      badge.className = 'status-badge ' + (enabled ? 'running' : 'stopped');
    }

    function saveNotionSettings() {
      const enabled = document.getElementById('notionEnabled').checked;
      const apiKey = document.getElementById('notionApiKey').value.trim();
      const databaseId = document.getElementById('notionDatabaseId').value.trim();

      if (enabled && (!apiKey || !databaseId)) {
        showAlert(false, 'API Key와 Database ID를 모두 입력하세요.');
        return;
      }

      ws.send(JSON.stringify({
        type: 'saveNotion',
        settings: { enabled, apiKey, databaseId }
      }));
    }

    function testNotion() {
      const apiKey = document.getElementById('notionApiKey').value.trim();
      const databaseId = document.getElementById('notionDatabaseId').value.trim();

      if (!apiKey || !databaseId) {
        showAlert(false, 'API Key와 Database ID를 입력하세요.');
        return;
      }

      ws.send(JSON.stringify({ type: 'testNotion', apiKey, databaseId }));
    }

    function openNotion() {
      const databaseId = document.getElementById('notionDatabaseId').value.trim();
      if (!databaseId) {
        showAlert(false, 'Database ID를 입력하세요.');
        return;
      }
      window.open('https://www.notion.so/' + databaseId.replace(/-/g, ''), '_blank');
    }

    function showAlert(success, message) {
      const el = document.getElementById('settingsAlert');
      el.innerHTML = \`<div class="alert \${success ? 'alert-success' : 'alert-error'}">\${message}</div>\`;
      setTimeout(() => el.innerHTML = '', 5000);
    }

    function addTask() {
      const input = document.getElementById('taskInput');
      const mission = input.value.trim();
      if (!mission) return;

      const profileSelect = document.getElementById('taskProfile');
      const selectedProfile = profileSelect.value;
      const profileName = profileSelect.options[profileSelect.selectedIndex]?.text || '';

      const taskId = 'task-' + (++taskIdCounter);
      const task = {
        id: taskId,
        mission: mission,
        profile: profileName,
        status: 'pending',
        logs: [],
        result: null
      };

      tasks.set(taskId, task);
      renderTaskCard(task);
      updateStats();

      ws.send(JSON.stringify({ type: 'run', taskId, mission, profile: selectedProfile }));
      input.value = '';
    }

    function renderTaskCard(task) {
      const grid = document.getElementById('tasksGrid');
      const card = document.createElement('div');
      card.className = 'task-card';
      card.id = 'card-' + task.id;
      card.innerHTML = getTaskCardHTML(task);
      grid.prepend(card);
    }

    function updateTaskCard(taskId) {
      const task = tasks.get(taskId);
      const card = document.getElementById('card-' + taskId);
      if (card && task) {
        card.innerHTML = getTaskCardHTML(task);
      }
    }

    function getTaskCardHTML(task) {
      const statusClass = 'status-' + task.status;
      const statusText = {pending:'대기중',running:'실행중',done:'완료',error:'에러',stopped:'중지됨'}[task.status] || task.status;
      const logs = task.logs.slice(-10).map(l => {
        if (l.includes('[TOOL]')) return '<span class="log-tool">' + escapeHtml(l) + '</span>';
        if (l.includes('[SUCCESS]')) return '<span class="log-success">' + escapeHtml(l) + '</span>';
        if (l.includes('[ERROR]')) return '<span class="log-error">' + escapeHtml(l) + '</span>';
        return escapeHtml(l);
      }).join('\\n');

      const isRunning = task.status === 'running' || task.status === 'pending';
      const isDone = task.status === 'done' || task.status === 'error' || task.status === 'stopped';
      const sourceIcon = task.source === 'telegram' ? '📱' : '🖥️';
      const profileBadge = task.profile ? \`<span style="color:#888;font-size:10px;margin-left:8px;">📁 \${task.profile}</span>\` : '';

      let html = \`
        <div class="task-header">
          <span class="task-id">\${sourceIcon} \${task.id}\${profileBadge}</span>
          <div class="task-actions">
            \${isRunning ? \`<button class="btn-stop" onclick="stopTask('\${task.id}')" title="중지">⏹</button>\` : ''}
            \${isDone ? \`<button class="btn-delete" onclick="deleteTask('\${task.id}')" title="삭제">🗑</button>\` : ''}
            <span class="task-status \${statusClass}">\${statusText}</span>
          </div>
        </div>
        <div class="task-mission">\${escapeHtml(task.mission)}</div>
        <div class="task-log">\${logs || '...'}</div>
      \`;

      if (task.result) {
        html += \`<div class="task-result">\${escapeHtml(task.result)}</div>\`;
      }

      return html;
    }

    function stopTask(taskId) {
      ws.send(JSON.stringify({ type: 'stopTask', taskId }));
      const task = tasks.get(taskId);
      if (task) {
        task.status = 'stopped';
        task.logs.push('[STOPPED] 사용자가 작업을 중지했습니다.');
        updateTaskCard(taskId);
        updateStats();
      }
    }

    function deleteTask(taskId) {
      ws.send(JSON.stringify({ type: 'deleteTask', taskId }));
      tasks.delete(taskId);
      const card = document.getElementById('card-' + taskId);
      if (card) card.remove();
      updateStats();
    }

    function escapeHtml(text) {
      return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function updateStats() {
      let total = 0, running = 0, done = 0;
      tasks.forEach(t => {
        total++;
        if (t.status === 'running' || t.status === 'pending') running++;
        if (t.status === 'done') done++;
      });
      document.getElementById('totalTasks').textContent = total;
      document.getElementById('runningTasks').textContent = running;
      document.getElementById('doneTasks').textContent = done;
    }

    function clearDone() {
      const toRemove = [];
      tasks.forEach((t, id) => {
        if (t.status === 'done' || t.status === 'error') {
          toRemove.push(id);
        }
      });
      toRemove.forEach(id => {
        tasks.delete(id);
        const card = document.getElementById('card-' + id);
        if (card) card.remove();
      });
      updateStats();
    }

    document.getElementById('taskInput').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') addTask();
    });

    connect();
  </script>
</body>
</html>`;

export interface WebClientConfig {
  port: number;
  onTask: (taskId: string, mission: string, send: (msg: any) => void, profile?: string) => Promise<void>;
  onTelegramStart?: (token: string, allowedUsers: number[]) => Promise<void>;
  onTelegramStop?: () => void;
  onSettingsChange?: (settings: Settings) => void;
  getProfiles?: () => ChromeProfile[];
  isExtensionConnected?: () => boolean;
}

// 중지된 작업 추적
export const stoppedTasks = new Set<string>();

// 연결된 WebSocket 클라이언트들
let connectedClients: Set<WebSocket> = new Set();

// 모든 클라이언트에게 브로드캐스트
export function broadcastToClients(msg: any): void {
  const data = JSON.stringify(msg);
  connectedClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// Notion에 결과 저장
export async function saveResultToNotion(
  taskId: string,
  mission: string,
  result: string
): Promise<{ success: boolean; message: string }> {
  const settings = loadSettings();

  if (!settings.notion?.enabled) {
    return { success: false, message: "Notion 저장이 비활성화되어 있습니다" };
  }

  const { apiKey, databaseId } = settings.notion;
  if (!apiKey || !databaseId) {
    return { success: false, message: "Notion API Key 또는 Database ID가 없습니다" };
  }

  try {
    // 먼저 데이터베이스 스키마 가져오기
    const dbRes = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Notion-Version": "2022-06-28"
      }
    });

    if (!dbRes.ok) {
      const err = await dbRes.json();
      return { success: false, message: `데이터베이스 조회 실패: ${err.message || dbRes.status}` };
    }

    const dbData = await dbRes.json();
    const properties = dbData.properties || {};

    // title 타입 속성 찾기
    let titlePropName = "Name";
    for (const [name, prop] of Object.entries(properties)) {
      if ((prop as any).type === "title") {
        titlePropName = name;
        break;
      }
    }

    // 페이지 속성 구성 (제목만 필수, 나머지는 있으면 추가)
    const pageProps: Record<string, any> = {
      [titlePropName]: {
        title: [{ text: { content: `[${taskId}] ${mission.slice(0, 80)}` } }]
      }
    };

    const res = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
      },
      body: JSON.stringify({
        parent: { database_id: databaseId },
        properties: pageProps,
        children: [
          {
            object: "block",
            type: "heading_2",
            heading_2: {
              rich_text: [{ text: { content: "📋 작업" } }]
            }
          },
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ text: { content: mission } }]
            }
          },
          {
            object: "block",
            type: "heading_2",
            heading_2: {
              rich_text: [{ text: { content: "✅ 결과" } }]
            }
          },
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ text: { content: result.slice(0, 2000) } }]
            }
          },
          {
            object: "block",
            type: "divider",
            divider: {}
          },
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ text: { content: `⏰ ${new Date().toLocaleString("ko-KR")}` } }]
            }
          }
        ]
      })
    });

    if (res.ok) {
      console.log(`[Notion] 결과 저장 완료: ${taskId}`);
      return { success: true, message: "Notion에 저장되었습니다" };
    } else {
      const err = await res.json();
      console.error(`[Notion] 저장 실패:`, err);
      return { success: false, message: `Notion 저장 실패: ${err.message || res.status}` };
    }
  } catch (e) {
    console.error(`[Notion] 저장 오류:`, e);
    return { success: false, message: `Notion 저장 오류: ${(e as Error).message}` };
  }
}

export function startWebClient(config: WebClientConfig): Promise<{ settings: Settings }> {
  return new Promise((resolve) => {
    const { port, onTask, onTelegramStart, onTelegramStop, onSettingsChange, getProfiles, isExtensionConnected } = config;
    let settings = loadSettings();
    let telegramRunning = false;

    const server = http.createServer((req, res) => {
      if (req.url === "/" || req.url === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(HTML_PAGE);
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });

    const wss = new WebSocketServer({ server, path: "/ws" });

    wss.on("connection", (ws) => {
      console.log("[WebClient] 클라이언트 연결됨");
      connectedClients.add(ws);

      // 초기 설정 전송
      ws.send(JSON.stringify({ type: "settings", settings }));
      ws.send(JSON.stringify({ type: "telegramStatus", running: telegramRunning }));
      if (isExtensionConnected) {
        ws.send(JSON.stringify({ type: "extensionStatus", connected: isExtensionConnected() }));
      }

      ws.on("message", async (data) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.type === "getSettings") {
            ws.send(JSON.stringify({ type: "settings", settings }));
            ws.send(JSON.stringify({ type: "telegramStatus", running: telegramRunning }));
          }

          else if (msg.type === "getProfiles") {
            const profiles = getProfiles?.() || [];
            ws.send(JSON.stringify({ type: "profiles", profiles }));
          }

          else if (msg.type === "saveTelegram") {
            settings.telegram = msg.settings;
            saveSettings(settings);
            onSettingsChange?.(settings);
            ws.send(JSON.stringify({ type: "settings", settings }));
            ws.send(JSON.stringify({ type: "alert", success: true, message: "텔레그램 설정이 저장되었습니다." }));
          }

          else if (msg.type === "toggleTelegram") {
            const enabled = msg.enabled;
            if (enabled && settings.telegram?.botToken) {
              try {
                await onTelegramStart?.(
                  settings.telegram.botToken,
                  settings.telegram.allowedUsers || []
                );
                telegramRunning = true;
                settings.telegram.enabled = true;
                saveSettings(settings);
              } catch (err) {
                ws.send(JSON.stringify({ type: "alert", success: false, message: `텔레그램 시작 실패: ${(err as Error).message}` }));
                telegramRunning = false;
              }
            } else if (!enabled) {
              onTelegramStop?.();
              telegramRunning = false;
              if (settings.telegram) {
                settings.telegram.enabled = false;
                saveSettings(settings);
              }
            } else {
              ws.send(JSON.stringify({ type: "alert", success: false, message: "Bot Token을 먼저 설정하세요." }));
            }
            // 상태 브로드캐스트
            wss.clients.forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: "telegramStatus", running: telegramRunning }));
              }
            });
          }

          else if (msg.type === "testTelegram") {
            const testToken = msg.token || settings.telegram?.botToken;
            if (!testToken) {
              ws.send(JSON.stringify({ type: "alert", success: false, message: "Bot Token을 입력하세요." }));
            } else {
              try {
                const res = await fetch(`https://api.telegram.org/bot${testToken}/getMe`);
                const data = await res.json();
                if (data.ok) {
                  ws.send(JSON.stringify({ type: "alert", success: true, message: `✅ 연결 성공! 봇: @${data.result.username}` }));
                } else {
                  ws.send(JSON.stringify({ type: "alert", success: false, message: `❌ 연결 실패: ${data.description}` }));
                }
              } catch (err) {
                ws.send(JSON.stringify({ type: "alert", success: false, message: `❌ 연결 실패: ${(err as Error).message}` }));
              }
            }
          }

          else if (msg.type === "testOllama") {
            const url = msg.url || "http://localhost:11434";
            try {
              const res = await fetch(url + "/api/tags");
              if (res.ok) {
                const data = await res.json();
                const models = data.models || [];
                ws.send(JSON.stringify({
                  type: "ollamaStatus",
                  connected: true,
                  models: models.map((m: any) => ({
                    name: m.name,
                    size: m.size ? (m.size / 1024 / 1024 / 1024).toFixed(1) + "GB" : ""
                  })),
                  message: `연결됨 (${models.length}개 모델)`
                }));
              } else {
                ws.send(JSON.stringify({ type: "ollamaStatus", connected: false, message: "응답 오류: " + res.status }));
              }
            } catch (err) {
              ws.send(JSON.stringify({ type: "ollamaStatus", connected: false, message: "연결 실패: " + (err as Error).message }));
            }
          }

          else if (msg.type === "saveAI") {
            settings.ai = msg.settings;
            saveSettings(settings);
            onSettingsChange?.(settings);
            ws.send(JSON.stringify({ type: "settings", settings }));
            ws.send(JSON.stringify({ type: "alert", success: true, message: "AI 설정이 저장되었습니다." }));
          }

          else if (msg.type === "saveBrowser") {
            settings.browser = msg.settings;
            saveSettings(settings);
            onSettingsChange?.(settings);
            ws.send(JSON.stringify({ type: "settings", settings }));
            ws.send(JSON.stringify({ type: "alert", success: true, message: "브라우저 설정이 저장되었습니다." }));
          }

          else if (msg.type === "saveNotion") {
            settings.notion = msg.settings;
            saveSettings(settings);
            onSettingsChange?.(settings);
            ws.send(JSON.stringify({ type: "settings", settings }));
            ws.send(JSON.stringify({ type: "alert", success: true, message: "Notion 설정이 저장되었습니다." }));
          }

          else if (msg.type === "testNotion") {
            const { apiKey, databaseId } = msg;
            try {
              const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
                method: "GET",
                headers: {
                  "Authorization": `Bearer ${apiKey}`,
                  "Notion-Version": "2022-06-28"
                }
              });
              if (res.ok) {
                const data = await res.json();
                ws.send(JSON.stringify({
                  type: "alert",
                  success: true,
                  message: `Notion 연결 성공! 데이터베이스: ${data.title?.[0]?.plain_text || databaseId}`
                }));
              } else {
                const err = await res.json();
                ws.send(JSON.stringify({
                  type: "alert",
                  success: false,
                  message: `Notion 연결 실패: ${err.message || res.status}`
                }));
              }
            } catch (e) {
              ws.send(JSON.stringify({ type: "alert", success: false, message: `Notion 연결 오류: ${(e as Error).message}` }));
            }
          }

          else if (msg.type === "stopTask") {
            const { taskId } = msg;
            console.log(`[WebClient] 작업 중지: ${taskId}`);
            stoppedTasks.add(taskId);
          }

          else if (msg.type === "deleteTask") {
            const { taskId } = msg;
            console.log(`[WebClient] 작업 삭제: ${taskId}`);
            stoppedTasks.delete(taskId);
          }

          else if (msg.type === "run") {
            const { taskId, mission, profile } = msg;
            console.log(`[WebClient] 작업 시작: ${taskId} - ${mission} (프로필: ${profile || '기본'})`);

            const send = (m: any) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ taskId, ...m }));
              }
            };

            send({ type: "status", status: "running" });

            try {
              await onTask(taskId, mission, send, profile);
            } catch (error) {
              send({ type: "error", text: (error as Error).message });
            }
          }
        } catch (e) {
          console.error("[WebClient] 메시지 처리 에러:", e);
        }
      });

      ws.on("close", () => {
        console.log("[WebClient] 클라이언트 연결 해제");
        connectedClients.delete(ws);
      });
    });

    server.listen(port, async () => {
      console.log(`[WebClient] 웹 UI: http://localhost:${port}`);

      // 설정에서 텔레그램이 활성화되어 있으면 자동 시작
      if (settings.telegram?.enabled && settings.telegram?.botToken && onTelegramStart) {
        try {
          console.log("[WebClient] 텔레그램 봇 자동 시작 중...");
          await onTelegramStart(settings.telegram.botToken, settings.telegram.allowedUsers || []);
          telegramRunning = true;
          console.log("[WebClient] 텔레그램 봇 시작됨");
        } catch (err) {
          console.error("[WebClient] 텔레그램 봇 시작 실패:", (err as Error).message);
        }
      }

      resolve({ settings });
    });
  });
}

// 직접 실행 시 서버 시작
if (import.meta.url === `file://${process.argv[1]}`) {
  startWebClient({
    port: 3000,
    onTask: async () => ({ success: true, message: "Standalone 모드에서는 작업 실행이 제한됩니다" }),
    getProfiles: () => scanChromeProfiles(),
    isExtensionConnected: () => false,
  }).catch(console.error);
}
