/**
 * Detects the real file type from its first bytes. Never trust the client's Content-Type:
 * a renamed executable must not pass as a PDF.
 */
export type AllowedMime = 'image/jpeg' | 'image/png' | 'application/pdf';

const SIGNATURES: Array<{ mime: AllowedMime; bytes: number[] }> = [
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // "%PDF-"
];

export const detectMime = (buffer: Buffer): AllowedMime | null =>
  SIGNATURES.find(({ bytes }) => buffer.length >= bytes.length && bytes.every((b, i) => buffer[i] === b))
    ?.mime ?? null;

export const IMAGE_MIMES: AllowedMime[] = ['image/jpeg', 'image/png'];
export const DOCUMENT_MIMES: AllowedMime[] = ['image/jpeg', 'image/png', 'application/pdf'];

/** Spec §7.4: max 10 MB. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
