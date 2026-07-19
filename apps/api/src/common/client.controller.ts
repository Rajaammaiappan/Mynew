/** Serves the browser test client at /client so a hosted API is self-testable
 *  (same origin ⇒ phone geolocation + no CORS friction). Dev tool, no auth. */
import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CANDIDATES = [
  join(__dirname, '../../../..', 'tools/test-client.html'), // monorepo/dist layout
  join(process.cwd(), 'tools/test-client.html'),            // docker WORKDIR /app
];

@Controller()
export class ClientController {
  @Get('client')
  client(@Res() res: Response) {
    const path = CANDIDATES.find((p) => existsSync(p));
    if (!path) return res.status(404).send('test client not bundled');
    res.type('html').send(readFileSync(path, 'utf8'));
  }
}
