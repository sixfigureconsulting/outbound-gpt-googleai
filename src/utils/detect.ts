import { Platform } from '../types';

export function detectPlatform(url: string): Platform {
  const lower = url.toLowerCase();
  if (lower.includes('linkedin.com')) return 'linkedin';
  if (lower.includes('facebook.com') || lower.includes('fb.com')) return 'facebook';
  if (lower.includes('instagram.com')) return 'instagram';
  throw new Error(
    `Unsupported URL. Please provide a LinkedIn, Facebook, or Instagram post URL.\nGot: ${url}`
  );
}
