import { Env } from '../src/types';
import index from '../src/index';

export const config = {
  runtime: 'edge',
};

export default async (req: Request) => {
  const env: Env = {
    TMDB_API_KEY: process.env.TMDB_API_KEY || ''
  };
  return index.fetch(req, env);
};
