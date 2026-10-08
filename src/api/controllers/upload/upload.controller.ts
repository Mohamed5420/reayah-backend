import { Router, type NextFunction, type Request, type Response } from 'express';
import { Container } from 'typedi';
import type IBaseController from '../interfaces/base-controller.interface';
import { CheckAppStatusMiddleware, UploadMiddleware } from '../../middlewares/app';
import { Auth } from '../../middlewares/auth';
import { z } from '../../validations/zod';
import { defineRoute } from '../../../docs/openapi';
import { StorageService, UPLOAD_PURPOSES, type UploadPurpose } from '../../../services/storage';
import { DOCUMENT_MIMES, IMAGE_MIMES, type AllowedMime } from '../../../utils/file-type';
import { HttpResponse } from '../../../utils/response/http-response';
import { ValidationError } from '../../../utils/types-errors';

const routes = {
  upload: defineRoute({
    method: 'post',
    path: '/uploads',
    summary:
      'Upload a private file (max 10 MB; JPG, PNG or PDF — avatars images only). Returns a temporary ' +
      '`file_key` to attach with the relevant endpoint; unattached files are removed after a day.',
    tags: ['Uploads'],
    auth: true,
    upload: { field: 'file' },
    request: { body: z.object({ purpose: z.enum(UPLOAD_PURPOSES) }) },
    response: {
      status: 201,
      schema: z
        .object({
          file_key: z.string().openapi({ example: 'tmp/665f.../medical_document/9f2c....pdf' }),
          mime: z.string().openapi({ example: 'application/pdf' }),
          size: z.number().openapi({ example: 482133 }),
        })
        .openapi('Upload'),
    },
  }),
};

const IMAGE_ONLY_PURPOSES: UploadPurpose[] = ['avatar', 'banner'];

/** Generic private upload (spec §7.4). Any signed-in role; the attach endpoint checks owner + purpose. */
export default class UploadController implements IBaseController {
  path = '/uploads';
  router = Router();

  private storage = Container.get(StorageService);

  constructor() {
    this.initializeRoutes();
  }

  initializeRoutes() {
    // The file must be parsed before its text fields can be validated, and only for signed-in users.
    this.router.post(
      routes.upload.path,
      CheckAppStatusMiddleware,
      ...Auth(),
      UploadMiddleware('file', DOCUMENT_MIMES),
      routes.upload.validate,
      this.upload.bind(this),
    );
  }

  private async upload(req: Request, res: Response, next: NextFunction) {
    try {
      const purpose = req.body.purpose as UploadPurpose;
      const file = req.file!;
      if (IMAGE_ONLY_PURPOSES.includes(purpose) && !IMAGE_MIMES.includes(file.mimetype as AllowedMime)) {
        throw new ValidationError({ file: ['validation.file_type'] });
      }
      const fileKey = await this.storage.putTemp(req.user!.id, purpose, file.buffer, file.mimetype);
      return HttpResponse.created(res, { file_key: fileKey, mime: file.mimetype, size: file.size });
    } catch (err) {
      next(err);
    }
  }
}
