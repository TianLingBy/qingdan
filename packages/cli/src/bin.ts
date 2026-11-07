#!/usr/bin/env node
import { Command } from 'commander';
import { buildCommandTree } from './cli.js';

await buildCommandTree(new Command()).parseAsync(process.argv);
