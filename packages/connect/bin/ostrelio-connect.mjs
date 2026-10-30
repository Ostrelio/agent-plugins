#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import { main } from '../src/cli.ts';

process.exitCode = await main(process.argv.slice(2), process.env);
