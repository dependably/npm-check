import _ from 'lodash';
import express from 'express';
import utc from 'dayjs/plugin/utc';
import type { Primitive } from 'type-fest';
import leftPad from 'left-pad';
import { helper } from '@app/helper';

const axios = require('axios');

export async function main(pluginName: string): Promise<void> {
  const { default: chalk } = await import('chalk');
  const plugin = require(pluginName); // non-literal: cannot be attributed
  const app = express();
  app.get('/', (_req: unknown, res: { send(s: string): void }) => {
    res.send(chalk.green(_.capitalize(helper(String(plugin)))));
  });
  void axios;
  void utc;
  void leftPad;
}

export type P = Primitive;
