export function requireSitesOwner(request: Request, ownerEmail: string | undefined): Response | undefined {
  if (!ownerEmail?.trim()) return new Response("Site owner access is not configured", { status: 503 });
  // These headers are trusted only behind Sites dispatch. Do not expose this
  // entrypoint through a Worker URL or another host that accepts spoofed headers.
  const userId = request.headers.get("oai-authenticated-user-id");
  const email = request.headers.get("oai-authenticated-user-email");
  if (!userId || !email) return new Response("Sign in to access Apple Music", { status: 401 });
  if (email.trim().toLowerCase() !== ownerEmail.trim().toLowerCase()) {
    return new Response("This Apple Music connection belongs to the Site owner", { status: 403 });
  }
}
