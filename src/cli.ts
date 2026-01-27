#!/usr/bin/env node
/**
 * Pi-Browser CLI
 * Multi-model AI browser control using Pi-AI
 *
 * Supported providers: OpenAI, Anthropic, Google, Mistral, Groq, OpenRouter, etc.
 */

import "dotenv/config";
import readline from "node:readline";
import { chromium, type Browser, type Page, type BrowserContext } from "playwright-core";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";

import { Type } from "@sinclair/typebox";
import {
  getModel,
  streamSimple,
  getProviders,
  getModels,
  type Context,
  type Tool,
  type Model,
  type AssistantMessage,
} from "@mariozechner/pi-ai";

// ============================================================
// 색상
// ============================================================
const c = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

// ============================================================
// 브라우저 모드 (CDP or Extension)
// ============================================================
type BrowserMode = "cdp" | "extension";
let browserMode: BrowserMode = "cdp";

// Extension 모드용 WebSocket
let wss: WebSocketServer | null = null;
let extClient: WebSocket | null = null;
let messageId = 0;
const pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

// Extension에 명령 전송
function sendExtCommand(command: string, params: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!extClient || extClient.readyState !== WebSocket.OPEN) {
      reject(new Error("Extension이 연결되지 않았습니다. Chrome에서 Pi-Browser 확장 프로그램을 확인하세요."));
      return;
    }

    const id = ++messageId;
    pendingRequests.set(id, { resolve, reject });

    extClient.send(JSON.stringify({ id, command, params }));

    // 타임아웃
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`명령 타임아웃: ${command}`));
      }
    }, 60000);
  });
}

// WebSocket 서버 시작
let extensionConnectedOnce = false;

function startExtensionServer(): Promise<void> {
  return new Promise((resolve) => {
    wss = new WebSocketServer({ port: 9876 });

    wss.on("connection", (ws) => {
      if (!extensionConnectedOnce) {
        console.log(`${c.green}✓ Extension 연결됨${c.reset}`);
        extensionConnectedOnce = true;
      }
      extClient = ws;

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          const pending = pendingRequests.get(msg.id);
          if (pending) {
            pendingRequests.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(msg.error));
            } else {
              pending.resolve(msg.result);
            }
          }
        } catch (e) {
          console.error("Extension 메시지 파싱 에러:", e);
        }
      });

      ws.on("close", () => {
        extClient = null;
      });

      resolve();
    });

    console.log(`${c.cyan}Extension 서버 시작됨 (ws://localhost:9876)${c.reset}`);
    console.log(`${c.dim}Chrome에서 Pi-Browser 확장 프로그램이 자동으로 연결됩니다.${c.reset}\n`);
  });
}

// Extension 서버 종료
function stopExtensionServer() {
  if (wss) {
    wss.close();
    wss = null;
  }
  extClient = null;
}

// ============================================================
// 브라우저 관리 (CDP 모드)
// ============================================================
interface RunningChrome {
  process: ChildProcess;
  cdpUrl: string;
  userDataDir: string;
}

let chromeProcess: RunningChrome | null = null;
let browser: Browser | null = null;
let context: BrowserContext | null = null;

function findChromeExecutable(): string | null {
  const platform = os.platform();
  const paths: string[] =
    platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : platform === "linux"
        ? ["/usr/bin/google-chrome", "/usr/bin/chromium"]
        : [
            path.join(process.env.PROGRAMFILES || "", "Google/Chrome/Application/chrome.exe"),
            path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
          ];

  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Chrome 프로필 목록 가져오기
function getChromeProfiles(): { name: string; path: string }[] {
  const chromeDir = path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
  const profiles: { name: string; path: string }[] = [];

  if (!fs.existsSync(chromeDir)) return profiles;

  const entries = fs.readdirSync(chromeDir);
  for (const entry of entries) {
    const profilePath = path.join(chromeDir, entry);
    const prefsPath = path.join(profilePath, "Preferences");

    if (fs.existsSync(prefsPath)) {
      try {
        const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
        const profileName = prefs?.profile?.name || entry;
        profiles.push({ name: profileName, path: profilePath });
      } catch {
        profiles.push({ name: entry, path: profilePath });
      }
    }
  }

  return profiles;
}

// 선택된 프로필 저장
let selectedProfile: string | null = null;

// 프로필에서 쿠키/로그인 정보 복사
async function importProfileData(sourceProfile: string): Promise<void> {
  const chromeDir = path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
  const sourcePath = path.join(chromeDir, sourceProfile);
  const targetPath = path.join(os.homedir(), ".pi-browser", "chrome-profile", "Default");

  // 소스 프로필 확인
  if (!fs.existsSync(sourcePath)) {
    console.log(`${c.red}프로필을 찾을 수 없습니다: ${sourceProfile}${c.reset}`);
    process.exit(1);
  }

  // 타겟 디렉토리 생성
  fs.mkdirSync(targetPath, { recursive: true });

  // 복사할 파일들 (쿠키, 로컬 스토리지, 로그인 데이터 등)
  const filesToCopy = [
    "Cookies",
    "Login Data",
    "Login Data For Account",
    "Web Data",
  ];

  const dirsToCopy = [
    "Local Storage",
    "Session Storage",
    "IndexedDB",
  ];

  console.log(`${c.cyan}프로필 데이터 복사 중...${c.reset}`);
  console.log(`${c.dim}소스: ${sourceProfile}${c.reset}`);
  console.log(`${c.dim}대상: pi-browser 프로필${c.reset}\n`);

  let copied = 0;

  // 파일 복사
  for (const file of filesToCopy) {
    const src = path.join(sourcePath, file);
    const dst = path.join(targetPath, file);
    if (fs.existsSync(src)) {
      try {
        fs.copyFileSync(src, dst);
        console.log(`  ${c.green}✓${c.reset} ${file}`);
        copied++;
      } catch (e) {
        console.log(`  ${c.yellow}⚠${c.reset} ${file} (복사 실패 - 파일이 사용 중일 수 있음)`);
      }
    }
  }

  // 디렉토리 복사
  for (const dir of dirsToCopy) {
    const src = path.join(sourcePath, dir);
    const dst = path.join(targetPath, dir);
    if (fs.existsSync(src)) {
      try {
        fs.cpSync(src, dst, { recursive: true, force: true });
        console.log(`  ${c.green}✓${c.reset} ${dir}/`);
        copied++;
      } catch (e) {
        console.log(`  ${c.yellow}⚠${c.reset} ${dir}/ (복사 실패)`);
      }
    }
  }

  if (copied > 0) {
    console.log(`\n${c.green}✓ 프로필 데이터가 복사되었습니다.${c.reset}`);
    console.log(`${c.dim}이제 pi-browser에서 로그인 상태가 유지됩니다.${c.reset}\n`);
  } else {
    console.log(`\n${c.yellow}복사된 파일이 없습니다.${c.reset}\n`);
  }
}

// Chrome을 특정 프로필로 CDP 포트와 함께 시작
async function startChromeWithProfile(profileDir: string): Promise<void> {
  const executablePath = findChromeExecutable();
  if (!executablePath) {
    console.log(`${c.red}Chrome을 찾을 수 없습니다.${c.reset}`);
    process.exit(1);
  }

  // 이미 9222 포트에 Chrome이 실행 중인지 확인
  try {
    const res = await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      console.log(`${c.green}✓ 기존 Chrome에 연결됨 (포트 9222)${c.reset}`);
      console.log(`${c.dim}이미 CDP 포트가 열린 Chrome이 실행 중입니다.${c.reset}\n`);
      return;
    }
  } catch {}

  const chromeDir = path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");

  // 프로필 존재 확인
  const profilePath = path.join(chromeDir, profileDir);
  if (!fs.existsSync(profilePath)) {
    console.log(`${c.red}프로필을 찾을 수 없습니다: ${profileDir}${c.reset}`);
    console.log(`${c.dim}/profiles 명령어로 사용 가능한 프로필을 확인하세요.${c.reset}\n`);
    process.exit(1);
  }

  console.log(`${c.cyan}Chrome 시작 중... (프로필: ${profileDir})${c.reset}`);
  console.log(`${c.yellow}⚠️  해당 프로필을 사용 중인 Chrome을 먼저 종료하세요!${c.reset}\n`);

  const args = [
    "--remote-debugging-port=9222",
    `--user-data-dir=${chromeDir}`,
    `--profile-directory=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];

  const proc = spawn(executablePath, args, {
    detached: true,
    stdio: "ignore",
  });
  proc.unref();

  // CDP 준비 대기
  console.log(`${c.dim}CDP 연결 대기 중...${c.reset}`);
  let connected = false;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(500) });
      if (res.ok) {
        connected = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }

  if (connected) {
    console.log(`${c.green}✓ Chrome이 CDP 포트 9222로 시작되었습니다.${c.reset}`);
    console.log(`${c.dim}이제 pi-browser가 이 Chrome에 자동으로 연결됩니다.${c.reset}\n`);
  } else {
    console.log(`${c.red}Chrome CDP 연결에 실패했습니다.${c.reset}`);
    console.log(`${c.dim}해당 프로필이 다른 Chrome에서 사용 중일 수 있습니다.${c.reset}\n`);
    process.exit(1);
  }
}

async function startBrowser(): Promise<void> {
  if (browser) return;

  // 1. 먼저 기존 브라우저 연결 시도 (포트 9222)
  const userCdpUrl = "http://127.0.0.1:9222";
  try {
    const res = await fetch(`${userCdpUrl}/json/version`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      console.log(`${c.green}✓ 기존 브라우저에 연결됨 (포트 9222)${c.reset}`);
      browser = await chromium.connectOverCDP(userCdpUrl);
      const contexts = browser.contexts();
      context = contexts[0] ?? (await browser.newContext());
      return;
    }
  } catch {
    // 기존 브라우저 없음 - 새로 실행
  }

  // 2. 새 브라우저 실행
  const executablePath = findChromeExecutable();
  if (!executablePath) throw new Error("Chrome not found");

  const cdpPort = 9444;

  // 프로필 경로 결정
  let userDataDir: string;
  let profileDir: string | undefined;

  if (selectedProfile) {
    // 사용자가 선택한 Chrome 프로필 사용
    const chromeDir = path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
    userDataDir = chromeDir;
    profileDir = selectedProfile;
    console.log(`${c.cyan}프로필: ${selectedProfile}${c.reset}`);
  } else {
    // 기본 pi-browser 프로필 사용
    userDataDir = path.join(os.homedir(), ".pi-browser", "chrome-profile");
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    ...(profileDir ? [`--profile-directory=${profileDir}`] : []),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "about:blank",
  ];

  const proc = spawn(executablePath, args, {
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const cdpUrl = `http://127.0.0.1:${cdpPort}`;

  // CDP 준비 대기
  let cdpReady = false;
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(500) });
      if (res.ok) {
        cdpReady = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!cdpReady) {
    // 프로세스가 살아있는지 확인
    if (proc.exitCode !== null || proc.killed) {
      throw new Error(
        selectedProfile
          ? `Chrome을 실행할 수 없습니다. '${selectedProfile}' 프로필이 다른 Chrome에서 사용 중일 수 있습니다.\n` +
            `해결방법: 해당 프로필을 사용하는 Chrome을 모두 종료하세요.`
          : "Chrome을 실행할 수 없습니다."
      );
    }
    throw new Error(`Chrome CDP 연결 시간 초과 (포트 ${cdpPort})`);
  }

  console.log(`${c.yellow}✓ 새 브라우저 실행됨${c.reset}`);
  chromeProcess = { process: proc, cdpUrl, userDataDir };
  browser = await chromium.connectOverCDP(cdpUrl);
  const contexts = browser.contexts();
  context = contexts[0] ?? (await browser.newContext());
}

async function stopBrowser(): Promise<void> {
  // 기존 브라우저에 연결한 경우 닫지 않음
  if (browser && chromeProcess) {
    await browser.close();
    browser = null;
    context = null;
  } else if (browser) {
    // 기존 브라우저는 연결만 해제
    browser = null;
    context = null;
  }
  if (chromeProcess) {
    chromeProcess.process.kill("SIGTERM");
    chromeProcess = null;
  }
}

async function getPage(): Promise<Page> {
  if (!context) throw new Error("Browser not running");
  const pages = context.pages();
  return pages[0] ?? (await context.newPage());
}

// ============================================================
// 브라우저 도구 정의
// ============================================================
const browserTools: Tool[] = [
  {
    name: "browser_navigate",
    description: "Navigate to a URL",
    parameters: Type.Object({
      url: Type.String({ description: "The URL to navigate to" }),
    }),
  },
  {
    name: "browser_click",
    description: "Click an element by selector",
    parameters: Type.Object({
      selector: Type.String({ description: "CSS selector or text selector" }),
    }),
  },
  {
    name: "browser_fill",
    description: "Fill text into an input field",
    parameters: Type.Object({
      selector: Type.String({ description: "CSS selector for the input field" }),
      text: Type.String({ description: "Text to fill" }),
    }),
  },
  {
    name: "browser_press",
    description: "Press a keyboard key",
    parameters: Type.Object({
      key: Type.String({ description: "Key to press such as Enter, Tab, Escape" }),
    }),
  },
  {
    name: "browser_screenshot",
    description: "Take a screenshot of the current page",
    parameters: Type.Object({}),
  },
  {
    name: "browser_snapshot",
    description: "Get the accessibility snapshot of the page with interactive elements",
    parameters: Type.Object({}),
  },
  {
    name: "browser_scroll",
    description: "Scroll the page up or down",
    parameters: Type.Object({
      direction: Type.String({ description: "Scroll direction: up or down" }),
    }),
  },
  {
    name: "browser_get_text",
    description: "Get text content from the page",
    parameters: Type.Object({
      selector: Type.String({ description: "CSS selector or empty string for full page" }),
    }),
  },
  {
    name: "browser_wait",
    description: "Wait for a condition: time, text to appear, text to disappear, or element",
    parameters: Type.Object({
      timeMs: Type.String({ description: "Wait time in milliseconds (e.g. 5000 for 5 seconds)" }),
      text: Type.String({ description: "Wait for this text to appear on page" }),
      textGone: Type.String({ description: "Wait for this text to disappear (e.g. Loading...)" }),
      selector: Type.String({ description: "Wait for this element to be visible" }),
    }),
  },
  {
    name: "browser_download",
    description: "Click a download button/link and save the file",
    parameters: Type.Object({
      selector: Type.String({ description: "Selector of download button/link to click" }),
      filename: Type.String({ description: "Filename to save as (e.g. song.mp3)" }),
    }),
  },
];

// ============================================================
// Extension 모드 도구 실행
// ============================================================
async function executeExtensionTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ text: string; image?: { data: string; mimeType: string } }> {
  switch (name) {
    case "browser_navigate": {
      const result = await sendExtCommand("navigate", { url: args.url });
      return { text: `Navigated to ${result.url}. Title: ${result.title}` };
    }

    case "browser_click": {
      const selector = args.selector as string;
      await sendExtCommand("click", { selector });
      return { text: `Clicked: ${selector}` };
    }

    case "browser_fill": {
      const selector = args.selector as string;
      const text = args.text as string;
      await sendExtCommand("fill", { selector, value: text });
      return { text: `Filled "${text}" into ${selector}` };
    }

    case "browser_press": {
      await sendExtCommand("press", { key: args.key });
      return { text: `Pressed: ${args.key}` };
    }

    case "browser_screenshot": {
      const result = await sendExtCommand("screenshot", {});
      // Extension에서 data URL 형식으로 반환
      const dataUrl = result.image as string;
      const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
      return {
        text: "Screenshot captured",
        image: {
          data: base64,
          mimeType: "image/png",
        },
      };
    }

    case "browser_snapshot": {
      const result = await sendExtCommand("snapshot", {});
      const elements = result.elements as Array<{
        ref: string;
        tag: string;
        text: string;
        selector: string;
      }>;

      const lines = elements
        .slice(0, 20)
        .map((el, i) => `[e${i + 1}] ${el.tag} "${el.text.slice(0, 50)}" → ${el.selector}`);

      return { text: `Page elements:\n${lines.join("\n")}` };
    }

    case "browser_scroll": {
      const direction = (args.direction as string) || "down";
      await sendExtCommand("scroll", { direction, amount: 500 });
      return { text: `Scrolled ${direction}` };
    }

    case "browser_get_text": {
      const result = await sendExtCommand("getText", {});
      const text = (result.text as string).slice(0, 5000);
      return { text: `Page text:\n${text}` };
    }

    case "browser_wait": {
      const timeMs = args.timeMs as number | undefined;
      if (timeMs) {
        await new Promise((r) => setTimeout(r, timeMs));
        return { text: `Waited ${timeMs}ms` };
      }
      return { text: "Waited" };
    }

    default:
      return { text: `Unknown tool: ${name}` };
  }
}

// ============================================================
// 브라우저 도구 실행 (CDP 모드)
// ============================================================
async function executeBrowserTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ text: string; image?: { data: string; mimeType: string } }> {
  // Extension 모드
  if (browserMode === "extension") {
    return executeExtensionTool(name, args);
  }

  // CDP 모드
  if (!browser) {
    await startBrowser();
  }

  const page = await getPage();

  switch (name) {
    case "browser_navigate": {
      await page.goto(args.url as string, { waitUntil: "domcontentloaded" });
      const title = await page.title();
      return { text: `Navigated to ${args.url}. Title: ${title}` };
    }

    case "browser_click": {
      const selector = args.selector as string;
      // role:"name" 형식 처리
      const roleMatch = selector.match(/^(\w+):"([^"]*)"$/);
      if (roleMatch) {
        const [, role, name] = roleMatch;
        await page.getByRole(role as any, { name, exact: false }).first().click();
      } else if (selector.match(/^\w+$/)) {
        // role만 있는 경우
        await page.getByRole(selector as any).first().click();
      } else {
        // 일반 CSS 셀렉터
        await page.locator(selector).first().click();
      }
      await page.waitForTimeout(1000);
      return { text: `Clicked: ${selector}` };
    }

    case "browser_fill": {
      const selector = args.selector as string;
      const text = args.text as string;
      // role:"name" 형식 처리
      const roleMatch = selector.match(/^(\w+):"([^"]*)"$/);
      if (roleMatch) {
        const [, role, name] = roleMatch;
        await page.getByRole(role as any, { name, exact: false }).first().fill(text);
      } else if (selector.match(/^\w+$/)) {
        // role만 있는 경우 (예: textbox, searchbox)
        await page.getByRole(selector as any).first().fill(text);
      } else {
        // 일반 CSS 셀렉터
        await page.locator(selector).first().fill(text);
      }
      return { text: `Filled "${text}" into ${selector}` };
    }

    case "browser_press": {
      await page.keyboard.press(args.key as string);
      await page.waitForTimeout(500);
      return { text: `Pressed: ${args.key}` };
    }

    case "browser_screenshot": {
      const buffer = await page.screenshot({ type: "jpeg", quality: 80 });
      return {
        text: "Screenshot captured",
        image: {
          data: buffer.toString("base64"),
          mimeType: "image/jpeg",
        },
      };
    }

    case "browser_snapshot": {
      // Playwright의 ariaSnapshot 사용 (클로드봇 방식)
      const ariaSnapshot = await page.locator(":root").ariaSnapshot();

      // 인터랙티브 요소만 추출
      const lines = String(ariaSnapshot || "").split("\n");
      const interactiveRoles = ["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio"];
      const results: string[] = [];
      let refIdx = 1;

      for (const line of lines) {
        const match = line.match(/^\s*-\s*(\w+)(?:\s+"([^"]*)")?/);
        if (!match) continue;

        const [, role, name] = match;
        if (!interactiveRoles.includes(role.toLowerCase())) continue;

        // ref 형식: role:name 또는 role만
        const ref = name ? `${role}:"${name}"` : role;
        results.push(`[e${refIdx}] ${role}${name ? ` "${name}"` : ""} → ${ref}`);
        refIdx++;

        if (refIdx > 20) break; // 최대 20개
      }

      return { text: `Page elements (use ref value for selector):\n${results.join("\n")}` };
    }

    case "browser_scroll": {
      const dir = args.direction as string;
      const amount = dir === "down" ? 500 : -500;
      await page.evaluate(`window.scrollBy(0, ${amount})`);
      return { text: `Scrolled ${dir}` };
    }

    case "browser_get_text": {
      const selector = args.selector as string | undefined;
      const text = selector
        ? (await page.locator(selector).first().textContent()) ?? ""
        : await page.evaluate(() => document.body.innerText);
      return { text: text.slice(0, 2000) };
    }

    case "browser_wait": {
      const timeMs = args.timeMs as string | undefined;
      const text = args.text as string | undefined;
      const textGone = args.textGone as string | undefined;
      const selector = args.selector as string | undefined;
      const results: string[] = [];

      // 시간 대기
      if (timeMs && parseInt(timeMs) > 0) {
        const ms = Math.min(parseInt(timeMs), 60000); // 최대 60초
        await page.waitForTimeout(ms);
        results.push(`Waited ${ms}ms`);
      }

      // 텍스트 나타날 때까지 대기
      if (text) {
        await page.getByText(text).first().waitFor({ state: "visible", timeout: 30000 });
        results.push(`Text "${text}" appeared`);
      }

      // 텍스트 사라질 때까지 대기
      if (textGone) {
        await page.getByText(textGone).first().waitFor({ state: "hidden", timeout: 60000 });
        results.push(`Text "${textGone}" disappeared`);
      }

      // 요소 나타날 때까지 대기
      if (selector) {
        await page.locator(selector).first().waitFor({ state: "visible", timeout: 30000 });
        results.push(`Element "${selector}" visible`);
      }

      return { text: results.length > 0 ? results.join(", ") : "Wait completed" };
    }

    case "browser_download": {
      const selector = args.selector as string;
      const filename = args.filename as string || "download";

      // 다운로드 대기 설정
      const downloadPromise = page.waitForEvent("download", { timeout: 120000 });

      // 다운로드 버튼 클릭
      const roleMatch = selector.match(/^(\w+):"([^"]*)"$/);
      if (roleMatch) {
        const [, role, name] = roleMatch;
        await page.getByRole(role as any, { name, exact: false }).first().click();
      } else if (selector.match(/^\w+$/)) {
        await page.getByRole(selector as any).first().click();
      } else {
        await page.locator(selector).first().click();
      }

      // 다운로드 완료 대기
      const download = await downloadPromise;
      const suggestedName = download.suggestedFilename();

      // 파일 저장
      const downloadDir = path.join(os.homedir(), "Downloads");
      const savePath = path.join(downloadDir, filename || suggestedName);
      await download.saveAs(savePath);

      return { text: `Downloaded: ${savePath} (${suggestedName})` };
    }

    default:
      return { text: `Unknown tool: ${name}` };
  }
}

// ============================================================
// 설정
// ============================================================
interface Config {
  provider: string;
  model: string;
  ollamaUrl?: string;
  chromeProfile?: string; // 사용자 Chrome 프로필 경로
}

const CONFIG_PATH = path.join(os.homedir(), ".pi-browser.json");

function loadConfig(): Config {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    }
  } catch {}
  return { provider: "google", model: "gemini-2.5-flash" };
}

function saveConfig(config: Config): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// Ollama 모델 생성
function createOllamaModel(modelId: string, baseUrl: string = "http://localhost:11434/v1"): Model {
  return {
    id: modelId,
    name: `${modelId} (Ollama)`,
    api: "openai-completions",
    provider: "ollama",
    baseUrl,
    reasoning: false,
    input: ["text"],
    output: ["text"],
    inputTokenLimit: 128000,
    outputTokenLimit: 8192,
  } as Model;
}

// 모델 가져오기 (Ollama 지원)
function resolveModel(config: Config): Model {
  if (config.provider === "ollama") {
    return createOllamaModel(config.model, config.ollamaUrl);
  }
  return getModel(config.provider as any, config.model as any);
}

// ============================================================
// 에이전트 루프
// ============================================================
async function runAgent(mission: string, model: Model, isOllama: boolean = false): Promise<void> {
  console.log(`\n${c.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log(`${c.bright}🎯 미션: ${mission}${c.reset}`);
  console.log(`${c.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}\n`);

  const ctx: Context = {
    systemPrompt: `You are a browser automation agent. Complete the user's mission using browser tools.

TOOLS:
- browser_navigate: {"url": "https://..."} - Go to URL
- browser_snapshot: {} - Get interactive elements with selectors
- browser_fill: {"selector": "...", "text": "..."} - Type text
- browser_click: {"selector": "..."} - Click element
- browser_press: {"key": "Enter"} - Press key
- browser_screenshot: {} - Capture screen
- browser_get_text: {"selector": ""} - Get page text
- browser_wait: {"timeMs": "5000"} - Wait for time (ms)
- browser_wait: {"text": "Complete"} - Wait for text to appear
- browser_wait: {"textGone": "Loading..."} - Wait for text to disappear
- browser_download: {"selector": "...", "filename": "file.mp3"} - Download file

WORKFLOW:
1. browser_navigate to the website
2. browser_snapshot to find element selectors
3. browser_fill/browser_click using EXACT selector from snapshot
4. browser_wait for loading/processing to complete
5. browser_download if file needs to be saved
6. Report results

SELECTOR FORMAT (from snapshot):
- role:"name" format: textbox:"Search", button:"Submit"
- Use EXACT value from snapshot output

AUTOMATION TIPS:
- Wait for "Loading" text to disappear before next action
- Wait for "Download" or "Complete" text before downloading
- Use browser_wait with textGone for loading states

Be concise. Complete the full task autonomously.`,
    messages: [{ role: "user", content: mission }],
    tools: browserTools,
  };

  const maxTurns = 100;

  for (let turn = 0; turn < maxTurns; turn++) {
    console.log(`${c.blue}[Turn ${turn + 1}/${maxTurns}]${c.reset}`);

    let response: AssistantMessage;

    try {
      // 스트리밍으로 응답 받기
      const streamOptions = isOllama ? { apiKey: "ollama" } : undefined;
      const s = streamSimple(model, ctx, streamOptions);
      let textBuffer = "";

      process.stdout.write(`${c.magenta}AI: ${c.reset}`);

      for await (const event of s) {
        if (event.type === "text_delta") {
          process.stdout.write(event.delta);
          textBuffer += event.delta;
        } else if (event.type === "tool_call_start") {
          console.log(`\n${c.dim}[tool: ${event.name}]${c.reset}`);
        }
      }

      response = await s.result();
      console.log();
    } catch (error) {
      console.log(`${c.red}Error: ${(error as Error).message}${c.reset}`);
      break;
    }

    ctx.messages.push(response);

    // 디버그: 응답 내용 출력
    if (response.content.length === 0) {
      console.log(`${c.dim}[DEBUG] Empty response content${c.reset}`);
    }

    // 도구 호출 처리
    const toolCalls = response.content.filter((b) => b.type === "toolCall");

    if (toolCalls.length === 0) {
      // 텍스트 응답이 있으면 완료
      const textContent = response.content.find((b) => b.type === "text");
      if (textContent) {
        console.log(`\n${c.green}✅ 미션 완료${c.reset}\n`);
      } else {
        console.log(`${c.yellow}⚠️ AI가 도구를 호출하지 않았습니다. 다시 시도...${c.reset}`);
        // 재시도 메시지 추가
        ctx.messages.push({
          role: "user",
          content: "도구를 사용해서 작업을 수행하세요. 먼저 browser_navigate로 웹사이트에 접속하세요.",
        });
        continue;
      }
      break;
    }

    // 도구 실행
    for (const call of toolCalls) {
      console.log(`${c.yellow}  → ${call.name}(${JSON.stringify(call.arguments)})${c.reset}`);

      try {
        const result = await executeBrowserTool(call.name, call.arguments as Record<string, unknown>);

        console.log(`${c.green}  ✓ ${result.text.split("\n")[0]}${c.reset}`);

        // 도구 결과 추가
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
          { type: "text", text: result.text },
        ];

        if (result.image) {
          content.push({
            type: "image",
            data: result.image.data,
            mimeType: result.image.mimeType,
          });
        }

        ctx.messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content,
          isError: false,
          timestamp: Date.now(),
        });
      } catch (error) {
        const errMsg = (error as Error).message;
        console.log(`${c.red}  ✗ ${errMsg}${c.reset}`);

        ctx.messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: `Error: ${errMsg}` }],
          isError: true,
          timestamp: Date.now(),
        });
      }
    }

    console.log();
  }
}

// ============================================================
// CLI
// ============================================================
function printBanner(config: Config) {
  console.log(`
${c.cyan}╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   ${c.bright}🤖 Pi-Browser CLI${c.reset}${c.cyan}                                          ║
║   ${c.dim}Multi-Model AI Browser Control${c.reset}${c.cyan}                             ║
║                                                               ║
╠═══════════════════════════════════════════════════════════════╣
║                                                               ║
║   ${c.yellow}현재 모델: ${config.provider}/${config.model}${c.cyan}
║                                                               ║
║   ${c.dim}명령어:${c.cyan}                                                    ║
║   ${c.green}/models${c.cyan} - 사용 가능한 모델 목록                           ║
║   ${c.green}/set <provider> <model>${c.cyan} - 모델 변경                       ║
║   ${c.green}/ollama-url <url>${c.cyan} - Ollama URL 설정                       ║
║   ${c.green}/config${c.cyan} - 현재 설정 확인                                  ║
║   ${c.green}exit${c.cyan} - 종료                                               ║
║                                                               ║
║   ${c.dim}예시:${c.cyan}                                                      ║
║   ${c.green}> 쿠팡에서 아이폰 16 가격 알려줘${c.cyan}                          ║
║   ${c.green}> 네이버에서 오늘 날씨 확인해줘${c.cyan}                           ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝${c.reset}
`);
}

function printModels() {
  const providers = getProviders();
  console.log(`\n${c.cyan}사용 가능한 Provider:${c.reset}`);

  // Ollama 추가
  console.log(`\n${c.yellow}ollama (로컬):${c.reset}`);
  console.log(`  - llama3.2`);
  console.log(`  - llama3.1`);
  console.log(`  - mistral`);
  console.log(`  - qwen2.5`);
  console.log(`  - gemma2`);
  console.log(`  ${c.dim}(ollama list로 설치된 모델 확인)${c.reset}`);

  for (const provider of providers) {
    const models = getModels(provider);
    console.log(`\n${c.yellow}${provider}:${c.reset}`);
    const modelIds = models.map((m) => m.id);
    for (const modelId of modelIds.slice(0, 10)) {
      console.log(`  - ${modelId}`);
    }
    if (modelIds.length > 10) {
      console.log(`  ... 외 ${modelIds.length - 10}개`);
    }
  }
  console.log();
}

async function main() {
  const config = loadConfig();

  // 커맨드 라인 인자 처리
  const rawArgs = process.argv.slice(2);
  let mission: string | null = null;

  // --ext 또는 /ext 옵션 확인
  const extIndex = rawArgs.findIndex((a) => a === "--ext" || a === "/ext");
  if (extIndex !== -1) {
    browserMode = "extension";
    rawArgs.splice(extIndex, 1);
  }

  // 인자 파싱: /profile과 미션을 분리
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];

    // Extension 모드 시작
    if (arg === "/ext") {
      browserMode = "extension";
      continue;
    }

    if (arg === "/models") {
      printModels();
      process.exit(0);
    }

    if (arg === "/profiles") {
      const profiles = getChromeProfiles();
      console.log(`\n${c.cyan}사용 가능한 Chrome 프로필:${c.reset}\n`);
      if (profiles.length === 0) {
        console.log(`  ${c.dim}프로필을 찾을 수 없습니다.${c.reset}`);
      } else {
        for (const p of profiles) {
          const dirName = path.basename(p.path);
          console.log(`  ${c.yellow}${dirName}${c.reset} - ${p.name}`);
        }
      }
      console.log(`\n${c.dim}사용법:${c.reset}`);
      console.log(`${c.dim}  /import <프로필> - 프로필의 로그인 정보를 pi-browser로 복사${c.reset}`);
      console.log(`${c.dim}  /connect <프로필> - 프로필로 Chrome을 CDP 포트와 함께 시작${c.reset}`);
      console.log(`${c.dim}예: /import "Profile 14"${c.reset}\n`);
      process.exit(0);
    }

    // /connect <profile> - Chrome을 CDP 포트로 시작하고 연결
    if (arg === "/connect" && i + 1 < rawArgs.length) {
      const profileName = rawArgs[i + 1];
      await startChromeWithProfile(profileName);
      i++;
      continue;
    }
    if (arg.startsWith("/connect ")) {
      const profileName = arg.slice(9).trim();
      await startChromeWithProfile(profileName);
      continue;
    }

    // /import <profile> - 프로필의 쿠키/로그인 정보 복사
    if (arg === "/import" && i + 1 < rawArgs.length) {
      const profileName = rawArgs[i + 1];
      await importProfileData(profileName);
      i++;
      continue;
    }
    if (arg.startsWith("/import ")) {
      const profileName = arg.slice(8).trim();
      await importProfileData(profileName);
      continue;
    }

    if (arg === "/config") {
      console.log(`\n${c.cyan}현재 설정:${c.reset}`);
      console.log(`  Provider: ${config.provider}`);
      console.log(`  Model: ${config.model}`);
      if (config.provider === "ollama") {
        console.log(`  Ollama URL: ${config.ollamaUrl || "http://localhost:11434/v1"}`);
      }
      console.log(`  Config: ${CONFIG_PATH}\n`);
      process.exit(0);
    }

    // /profile 처리 (다음 인자가 프로필 이름)
    if (arg === "/profile" && i + 1 < rawArgs.length) {
      selectedProfile = rawArgs[i + 1];
      console.log(`${c.green}프로필 선택됨: ${selectedProfile}${c.reset}`);
      console.log(`${c.dim}주의: 해당 프로필을 사용 중인 Chrome을 먼저 종료하세요!${c.reset}\n`);
      i++; // 프로필 이름 건너뛰기
      continue;
    }

    // /profile <name> 형식 (공백 포함된 단일 인자)
    if (arg.startsWith("/profile ")) {
      selectedProfile = arg.slice(9).trim();
      console.log(`${c.green}프로필 선택됨: ${selectedProfile}${c.reset}`);
      console.log(`${c.dim}주의: 해당 프로필을 사용 중인 Chrome을 먼저 종료하세요!${c.reset}\n`);
      continue;
    }

    // /set 처리
    if (arg.startsWith("/set ")) {
      const parts = arg.slice(5).split(" ");
      if (parts.length >= 2) {
        const [provider, ...modelParts] = parts;
        const model = modelParts.join(" ");

        if (provider === "ollama") {
          config.provider = provider;
          config.model = model;
          saveConfig(config);
          console.log(`${c.green}Ollama 모델 설정됨: ${model}${c.reset}`);
          console.log(`${c.dim}URL: ${config.ollamaUrl || "http://localhost:11434/v1"}${c.reset}\n`);
        } else {
          try {
            getModel(provider as any, model as any);
            config.provider = provider;
            config.model = model;
            saveConfig(config);
            console.log(`${c.green}모델 변경됨: ${provider}/${model}${c.reset}\n`);
          } catch (error) {
            console.log(`${c.red}잘못된 모델: ${(error as Error).message}${c.reset}\n`);
          }
        }
      } else {
        console.log(`${c.yellow}사용법: /set <provider> <model>${c.reset}`);
      }
      process.exit(0);
    }

    // /ollama-url 처리
    if (arg.startsWith("/ollama-url ")) {
      const url = arg.slice(12).trim();
      config.ollamaUrl = url;
      saveConfig(config);
      console.log(`${c.green}Ollama URL 설정됨: ${url}${c.reset}\n`);
      process.exit(0);
    }

    // 일반 인자는 미션으로 처리
    if (!arg.startsWith("/")) {
      mission = arg;
    }
  }

  // Extension 모드일 때 서버 시작
  if (browserMode === "extension") {
    console.log(`\n${c.cyan}🔌 Extension 모드${c.reset}`);
    await startExtensionServer();

    // Extension 연결 대기
    console.log(`${c.dim}Extension 연결 대기 중... (Chrome에서 Pi-Browser 확장 프로그램 확인)${c.reset}`);

    // 최대 60초 대기
    for (let i = 0; i < 120; i++) {
      if (extClient) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!extClient) {
      console.log(`${c.red}Extension 연결 타임아웃${c.reset}`);
      console.log(`${c.dim}Chrome에서 Pi-Browser 확장 프로그램을 설치하고 활성화하세요.${c.reset}`);
      console.log(`${c.dim}확장 프로그램 위치: ${path.join(process.cwd(), "extension")}${c.reset}\n`);
      stopExtensionServer();
      process.exit(1);
    }
  }

  // 미션이 있으면 실행
  if (mission) {
    try {
      const model = resolveModel(config);
      const isOllama = config.provider === "ollama";
      await runAgent(mission, model, isOllama);
    } catch (error) {
      console.log(`${c.red}Error: ${(error as Error).message}${c.reset}`);
    }
    if (browserMode === "extension") {
      stopExtensionServer();
    } else {
      await stopBrowser();
    }
    process.exit(0);
  }

  printBanner(config);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    const status = browser ? `${c.green}●${c.reset}` : `${c.red}○${c.reset}`;
    rl.question(`${status} ${c.cyan}>${c.reset} `, async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        prompt();
        return;
      }

      // 종료
      if (["exit", "quit", "종료", "q"].includes(trimmed.toLowerCase())) {
        console.log(`\n${c.yellow}종료 중...${c.reset}`);
        await stopBrowser();
        rl.close();
        process.exit(0);
      }

      // 모델 목록
      if (trimmed === "/models") {
        printModels();
        prompt();
        return;
      }

      // 설정 확인
      if (trimmed === "/config") {
        console.log(`\n${c.cyan}현재 설정:${c.reset}`);
        console.log(`  Provider: ${config.provider}`);
        console.log(`  Model: ${config.model}`);
        if (config.provider === "ollama") {
          console.log(`  Ollama URL: ${config.ollamaUrl || "http://localhost:11434/v1"}`);
        }
        console.log(`  Config: ${CONFIG_PATH}\n`);
        prompt();
        return;
      }

      // 모델 변경
      if (trimmed.startsWith("/set ")) {
        const parts = trimmed.slice(5).split(" ");
        if (parts.length >= 2) {
          const [provider, ...modelParts] = parts;
          const model = modelParts.join(" ");

          if (provider === "ollama") {
            config.provider = provider;
            config.model = model;
            saveConfig(config);
            console.log(`${c.green}Ollama 모델 설정됨: ${model}${c.reset}\n`);
          } else {
            try {
              getModel(provider as any, model as any);
              config.provider = provider;
              config.model = model;
              saveConfig(config);
              console.log(`${c.green}모델 변경됨: ${provider}/${model}${c.reset}\n`);
            } catch (error) {
              console.log(`${c.red}잘못된 모델: ${(error as Error).message}${c.reset}\n`);
            }
          }
        } else {
          console.log(`${c.yellow}사용법: /set <provider> <model>${c.reset}`);
          console.log(`${c.dim}예: /set ollama llama3.2${c.reset}`);
          console.log(`${c.dim}예: /set google gemini-2.5-flash${c.reset}\n`);
        }
        prompt();
        return;
      }

      // Ollama URL 설정
      if (trimmed.startsWith("/ollama-url ")) {
        const url = trimmed.slice(12).trim();
        config.ollamaUrl = url;
        saveConfig(config);
        console.log(`${c.green}Ollama URL 설정됨: ${url}${c.reset}\n`);
        prompt();
        return;
      }

      // 도움말
      if (trimmed === "/help" || trimmed === "?") {
        printBanner(config);
        prompt();
        return;
      }

      // 미션 실행
      try {
        const model = resolveModel(config);
        const isOllama = config.provider === "ollama";
        await runAgent(trimmed, model, isOllama);
      } catch (error) {
        console.log(`${c.red}Error: ${(error as Error).message}${c.reset}`);
      }

      prompt();
    });
  };

  prompt();

  process.on("SIGINT", async () => {
    console.log(`\n${c.yellow}종료 중...${c.reset}`);
    await stopBrowser();
    process.exit(0);
  });
}

main().catch(console.error);
