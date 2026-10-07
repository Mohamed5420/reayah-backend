import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { ValidationError, TooManyRequestsError } from '../../../utils/types-errors';
import { detectMime, MAX_UPLOAD_BYTES, type AllowedMime } from '../../../utils/file-type';
import { isOverLimit } from '../../../utils/rate-limit';

/** Uploads per user per hour — 10 MB each, so this caps abuse at ~600 MB/hour/user. */
const UPLOADS_PER_HOUR = 60;

/**
 * Accepts one multipart file in `field` (kept in memory, max 10 MB) and checks its real type from
 * the file's bytes. Sets `req.file.mimetype` to the detected type. Text fields land in `req.body`.
 * Must run after `Auth(...)` — anonymous clients can't make the server buffer 10 MB.
 */
export const UploadMiddleware = (field: string, allowed: AllowedMime[]) => {
  const parse = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10 },
  }).single(field);

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (await isOverLimit(`uploads:${req.user!.id}`, UPLOADS_PER_HOUR, 3600)) {
        return next(new TooManyRequestsError());
      }
    } catch (err) {
      return next(err);
    }

    parse(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        const key = err.code === 'LIMIT_FILE_SIZE' ? 'validation.file_too_large' : 'validation.invalid_value';
        return next(new ValidationError({ [err.field ?? field]: [key] }));
      }
      if (err) return next(err);
      if (!req.file) return next(new ValidationError({ [field]: ['validation.required'] }));

      const mime = detectMime(req.file.buffer);
      if (!mime || !allowed.includes(mime)) {
        return next(new ValidationError({ [field]: ['validation.file_type'] }));
      }
      req.file.mimetype = mime;
      next();
    });
  };
};
