"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";

export async function connectAnalytics(projectId: string, rawPropertyId: string) {
  const propertyId = rawPropertyId.trim();
  if (!projectId) return { ok: false, error: "Pick a project." };
  if (/^g-/i.test(propertyId)) {
    return {
      ok: false,
      error: "That is the Measurement ID. Use the Property ID: digits only, in Admin > Property details.",
    };
  }
  if (!/^\d+$/.test(propertyId)) return { ok: false, error: "The Property ID is digits only." };

  const taken = await prisma.project.findUnique({
    where: { ga4PropertyId: propertyId },
    select: { id: true, name: true },
  });
  if (taken && taken.id !== projectId) {
    return { ok: false, error: `That property is already on ${taken.name}.` };
  }

  await prisma.project.update({ where: { id: projectId }, data: { ga4PropertyId: propertyId } });
  revalidatePath("/analytics");
  return { ok: true };
}

/** Only unlinks the project here. The data stays in Google Analytics. */
export async function disconnectAnalytics(projectId: string) {
  await prisma.project.update({ where: { id: projectId }, data: { ga4PropertyId: null } });
  revalidatePath("/analytics");
}
