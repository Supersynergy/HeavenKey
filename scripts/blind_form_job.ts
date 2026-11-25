#!/usr/bin/env bun
import { readFile } from 'node:fs/promises';
import { planBlindJob } from '../packages/forms/blind-job';

const args = process.argv.slice(2);
const usage = 'Usage: bun scripts/blind_form_job.ts [--submit] [--overwrite] [--no-choices] [--map FIELD_ID=ENTITY] <scan.json|-> > job.json';
if (args.includes('--help')) { console.log(usage); process.exit(0); }
let submit = false, overwrite = false, choices = true, input: string | null = null;
const mapping: Record<string, string> = {};
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--submit') submit = true;
  else if (arg === '--overwrite') overwrite = true;
  else if (arg === '--no-choices') choices = false;
  else if (arg === '--map' || arg.startsWith('--map=')) {
    const pair = arg === '--map' ? args[++index] || '' : arg.slice(6), split = pair.indexOf('=');
    if (split < 1) throw new Error('--map needs FIELD_ID=ENTITY');
    mapping[pair.slice(0, split)] = pair.slice(split + 1);
  } else if (!input && (arg === '-' || arg.endsWith('.json'))) input = arg;
  else throw new Error(`Unknown argument: ${arg}\n${usage}`);
}
if (!input) throw new Error(usage);
const raw = input === '-' ? await new Response(Bun.stdin.stream()).text() : await readFile(input, 'utf8');
if (raw.length > 262_144) throw new Error('Scan export is too large.');
const job = planBlindJob(JSON.parse(raw), { submit, overwrite, choices, mapping });
process.stdout.write(JSON.stringify(job, null, 2) + '\n');
