import { NextResponse } from "next/server";
import { triggerSync } from "@/app/actions";

// A full sweep of both scopes makes hundreds of API calls; give it room.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Cron entry point. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`.
 *
 * The check is unconditional — an unauthenticated endpoint that hammers the
 * GitHub and Vercel APIs is exactly the kind of thing that gets left publicly
 * reachable and forgotten about.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await triggerSync();
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
