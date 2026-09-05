export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/backend" || url.pathname === "/backend/") {
      const backendURL = new URL("/backend.html", url.origin);
      return env.ASSETS.fetch(new Request(backendURL, request));
    }
    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      const indexURL = new URL("/index.html", url.origin);
      return env.ASSETS.fetch(new Request(indexURL, request));
    }
    return env.ASSETS.fetch(request);
  }
};
