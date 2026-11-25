import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'.',testMatch:'.core-history-check.spec.ts',timeout:95000,expect:{timeout:7000},use:{baseURL:'http://127.0.0.1:4877',viewport:{width:1360,height:850},timezoneId:'UTC',locale:'en-US'},outputDir:'/tmp/ahm-core-history-check-results'});
