import { publicPost } from '@/lib/server';

export const POST = (req: Request) => publicPost(req, 'forgot-password');
