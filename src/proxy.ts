import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * HTTP Basic auth gate.
 *
 * This app has no login of its own yet, and Vercel Authentication only covers
 * production deployments on paid plans — so without this, the whole project
 * inventory (repos, domains, which clients we work for) is readable by anyone
 * who has the URL. This is the stopgap until GitHub OAuth lands.
 *
 * /api/sync is exempt: it carries its own CRON_SECRET bearer check, and Vercel
 * Cron cannot send Basic credentials.
 */
export function proxy(request: NextRequest) {
  const expected = process.env.APP_PASSWORD;

  // Fail closed. A missing password must not silently disable the gate.
  if (!expected) {
    return new NextResponse("APP_PASSWORD is not configured", { status: 503 });
  }

  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = atob(header.slice(6));
    const password = decoded.slice(decoded.indexOf(":") + 1);
    if (timingSafeEqual(password, expected)) {
      return NextResponse.next();
    }
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="AI Project CRM", charset="UTF-8"' },
  });
}

/** Constant-time compare, so a wrong password leaks nothing via response time. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export const config = {
  // Everything except the cron endpoint and Next's own static assets.
  matcher: ["/((?!api/sync|_next/static|_next/image|favicon.ico).*)"],
};
