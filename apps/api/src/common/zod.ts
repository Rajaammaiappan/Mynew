import { HttpStatus } from '@nestjs/common';
import { ZodType, z } from 'zod';
import { Problem } from './problem';

export function parse<T extends ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const detail = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Problem(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', detail);
  }
  return r.data;
}
