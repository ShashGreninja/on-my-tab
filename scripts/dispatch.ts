import { dispatch } from '../src/runtime.ts';

const results = await Promise.allSettled([dispatch('reconcile'), dispatch('indexAudit')]);
if (results.some(result => result.status === 'rejected')) throw new Error('Workflow dispatch failed; scheduled sweep will retry');
