/* Serves the static site in ./public. Kept as a Worker so the existing wrangler
   and Freebuff configs stay valid and an /api route can be added here later. */
export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  }
};
