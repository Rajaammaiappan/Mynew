import { HttpException, HttpStatus } from '@nestjs/common';

/** RFC 9457 problem+json with stable machine codes. */
export class Problem extends HttpException {
  constructor(status: HttpStatus, code: string, detail: string) {
    super({ type: 'about:blank', title: HttpStatus[status], status, code, detail }, status);
  }
}
