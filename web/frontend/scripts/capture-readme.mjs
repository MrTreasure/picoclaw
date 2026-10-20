// Documentation capture against a disposable Launcher, never the production gateway.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const root = resolve(import.meta.dirname, '../../..');
const binary = process.env.MUSE_LAUNCHER_BINARY ?? resolve(root, 'build/picoclaw-launcher');
if (!existsSync(binary)) throw new Error('Build a Launcher first; see docs/muse-demo.md or set MUSE_LAUNCHER_BINARY.');
const directory = resolve(root, '.cache/readme-captures', randomUUID());
const workspace = resolve(directory, 'workspace'); const origin = 'http://127.0.0.1:18809';
const output = resolve(root, 'docs/screenshots');
const fixture = JSON.parse(await readFile(resolve(root, 'docs/examples/readme-demo.json'), 'utf8'));
await mkdir(resolve(workspace, 'sessions'), { recursive: true }); await mkdir(output, { recursive: true }); await mkdir(resolve(directory, 'builtin-skills'), { recursive: true });
for (const session of fixture.sessions) await writeFile(resolve(workspace, 'sessions', session.key.replaceAll(':', '_') + '.json'), JSON.stringify(session));
for (const skill of fixture.skills) {
  const folder = resolve(workspace, 'skills', skill.name); await mkdir(folder, { recursive: true });
  await writeFile(resolve(folder, 'SKILL.md'), `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n# README 演示 Skill\n\n这是独立编写的演示说明，不读取个人凭据或真实记录。先理解目标，再整理来源，最后输出可审阅的结果。\n`);
}
await writeFile(resolve(directory, 'config.json'), JSON.stringify({ agents: { defaults: { workspace, model_name: 'readme-offline' } }, model_list: [], channels: { pico: { enabled: false } }, gateway: { host: '127.0.0.1', port: 19873 } }));
await writeFile(resolve(directory, 'launcher-config.json'), JSON.stringify({ port: 18809, public: false, allow_localhost_bypass: true }));
try { await fetch(origin, { signal: AbortSignal.timeout(1000) }); throw new Error('Port 18809 is occupied.'); } catch (error) { if (error.message.startsWith('Port')) throw error; }
const child = spawn(binary, ['-console', '-no-browser', '-host', '127.0.0.1', '-port', '18809', resolve(directory, 'config.json')], {
  cwd: directory, detached: true, env: { ...process.env, PICOCLAW_HOME: directory, PICOCLAW_BUILTIN_SKILLS: resolve(directory, 'builtin-skills') }, stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; child.stdout.on('data', chunk => { log = (log + chunk).slice(-3000); }); child.stderr.on('data', chunk => { log = (log + chunk).slice(-3000); });
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { if ((await fetch(origin + '/api/auth/status')).ok) { ready = true; break; } } catch {}
    if (child.exitCode != null) throw new Error('Launcher exited: ' + log);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error('Launcher not ready: ' + log);
  browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1050 }, locale: 'zh-CN', colorScheme: 'dark', reducedMotion: 'reduce' });
  // This branch has a host-specific Codex target. Prevent any connection to it in the demo.
  await context.route('**/api/codex/**', route => route.abort());
  await context.routeWebSocket('**/api/codex/app-server/ws', socket => socket.close());
  await context.addInitScript(() => { localStorage.setItem('i18nextLng', 'zh'); localStorage.setItem('theme', 'dark'); localStorage.setItem('picoclaw-tour-state', JSON.stringify({ currentStep: 'completed', isActive: false })); });
  const password = randomBytes(24).toString('hex');
  for (const [path, data] of [['setup', { password, confirm: password }], ['login', { password }]]) {
    const response = await context.request.post(`${origin}/api/auth/${path}`, { data, headers: { Origin: origin } });
    if (!response.ok()) throw new Error(`Demo authentication ${path} failed: ${response.status()}`);
  }
  const page = await context.newPage();
  await page.goto(origin + '/sessions', { waitUntil: 'networkidle' });
  await page.getByText(/请把这份虚构的海洋研究计划/).first().waitFor();
  const museFilter = page.getByRole('button', { name: 'Muse', exact: true }); if (await museFilter.count()) await museFilter.click();
  await page.screenshot({ path: resolve(output, 'muse-sessions.webp'), type: 'webp', quality: 86 });
  const id = fixture.sessions[0].key.split(':').at(-1);
  await page.goto(origin + '/?session_id=' + id, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '已整理的页面内容', exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, 'muse-chat.webp'), type: 'webp', quality: 86 });
  await page.setViewportSize({ width: 430, height: 932 });
  await page.screenshot({ path: resolve(output, 'muse-mobile.webp'), type: 'webp', quality: 86 });
  await page.setViewportSize({ width: 1600, height: 1050 });
  await page.goto(origin + '/agent/skills', { waitUntil: 'networkidle' });
  await page.getByText('demo-research', { exact: true }).first().waitFor();
  await page.screenshot({ path: resolve(output, 'muse-skills.webp'), type: 'webp', quality: 86 });
  console.log('Captured four real Muse views using disposable, preset sessions. No live model or production session was used.');
} finally { await browser?.close(); try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
