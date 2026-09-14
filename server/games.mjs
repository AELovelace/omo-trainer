export function createGamesRoute(base, env = process.env) {
  const origin = new URL(env.LIDOLLBOT_PUBLIC_ORIGIN || 'https://bot.lidoll.dev');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' ||
      (origin.protocol !== 'https:' && !(env.NODE_ENV !== 'production' && local && origin.protocol === 'http:'))) throw new Error('LIDOLLBOT_PUBLIC_ORIGIN must be the bot HTTPS origin without a path.');
  const paths = new Map(['diapers','hangman','touhou'].map(game => [`${base}games/${game}`, `/${game}/login`]));
  return (request, response, pathname) => {
    if (!pathname.startsWith(`${base}games/`)) return false;
    response.setHeader('Cache-Control','no-store');
    if (!['GET','HEAD'].includes(request.method)) {response.writeHead(405,{Allow:'GET, HEAD'});response.end();return true;}
    const route=paths.get(pathname);
    if(!route){response.writeHead(404);response.end('Game not found.');return true;}
    response.writeHead(303,{Location:new URL(route,origin).href});response.end();return true;
  };
} // Redirect only fixed game names to trusted bot sign-in pages; forward no PWA cookies, tokens or query parameters.
