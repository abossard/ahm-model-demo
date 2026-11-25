import { test } from '@playwright/test';
import { Capture } from './onboarding/capture';
import { installCore, coreUrl } from './onboarding/core/replay';
import { history } from './onboarding/core/history';
import { mkdir } from 'node:fs/promises';
test('history check', async ({page})=>{
 await mkdir('/tmp/ahm-core-history-check/media',{recursive:true}); await installCore(page);
 await page.goto(coreUrl); await history(page,new Capture(page,'/tmp/ahm-core-history-check'));
});
