import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<h1 id=x>ok</h1>');
console.log('TEXT', await page.locator('#x').textContent());
await browser.close();
