import { Env } from '../../src/types';
import index from '../../src/index';

export default async (req: Request, context: any) => {
  return index.fetch(req, { TMDB_API_KEY: process.env.TMDB_API_KEY });
};
