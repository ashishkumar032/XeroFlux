import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
const python=resolve('../backend/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const reuseExistingServer=process.env.PLAYWRIGHT_REUSE_SERVER==='1'||!process.env.CI;
export default defineConfig({
 testDir:'./e2e',timeout:120_000,expect:{timeout:30_000},workers:1,
 use:{baseURL:'http://127.0.0.1:5173',screenshot:'only-on-failure',launchOptions:{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}},
 projects:[{name:'desktop',use:{...devices['Desktop Chrome'],viewport:{width:1440,height:900}}},{name:'mobile',use:{...devices['iPhone 13'],defaultBrowserType:'chromium',viewport:{width:390,height:844}}}],
 webServer:[
  {command:`"${python}" -m uvicorn app.main:app --app-dir "${resolve('../backend')}" --host 127.0.0.1 --port 8000`,url:'http://127.0.0.1:8000/api/v1/health',reuseExistingServer,timeout:30_000},
  {command:'npm.cmd run dev -- --host 127.0.0.1',url:'http://127.0.0.1:5173',reuseExistingServer,timeout:30_000},
 ],
});
