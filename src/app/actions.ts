"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { runSync } from "@/lib/sync";
import type { NoteAuthor, ProjectStage } from "@/generated/prisma/enums";

/**
 * Every field on this list is human-owned — the sync engine never writes them,
 * so an edit here survives the next sweep.
 */
export async function updateProjectAssignment(
  projectId: string,
  patch: {
    name?: string;
    stage?: ProjectStage;
    clientId?: string | null;
    endCustomerId?: string | null;
    notes?: string | null;
    hidden?: boolean;
    sendsEmailOverride?: boolean | null;
    usesSharePointOverride?: boolean | null;
    externalDataOverride?: boolean | null;
  },
) {
  await prisma.project.update({ where: { id: projectId }, data: patch });
  revalidatePath("/");
}

/**
 * Cycles a capability flag through three states: inherit detection → forced on
 * → forced off → back to inherit. Being able to get back to "inherit" matters,
 * otherwise one stray click permanently detaches the cell from the sync.
 */
export async function cycleCapabilityOverride(
  projectId: string,
  field: "sendsEmailOverride" | "usesSharePointOverride" | "externalDataOverride",
) {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: {
      sendsEmailOverride: true,
      usesSharePointOverride: true,
      externalDataOverride: true,
    },
  });

  const current = project[field];
  const next = current === null ? true : current === true ? false : null;

  await prisma.project.update({ where: { id: projectId }, data: { [field]: next } });
  revalidatePath("/");
}

/**
 * Append a timestamped note to a project's journal. `author` defaults to CARL
 * for notes typed into the UI; pass ASSISTANT when Claude records something on
 * his behalf. The created-at timestamp is set by the database.
 */
export async function addProjectNote(
  projectId: string,
  body: string,
  author: NoteAuthor = "CARL",
) {
  const text = body.trim();
  if (!text) return { ok: false as const, error: "Note is empty" };

  await prisma.projectNote.create({ data: { projectId, body: text, author } });
  revalidatePath("/");
  return { ok: true as const };
}

export async function deleteProjectNote(noteId: string) {
  await prisma.projectNote.delete({ where: { id: noteId } });
  revalidatePath("/");
}

export async function createOrganization(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false as const, error: "Name is required" };

  const parentId = String(formData.get("parentId") ?? "") || null;
  const slug = slugify(name);

  const clash = await prisma.organization.findFirst({
    where: { OR: [{ name }, { slug }] },
  });
  if (clash) return { ok: false as const, error: `"${name}" already exists` };

  await prisma.organization.create({ data: { name, slug, parentId } });
  revalidatePath("/organizations");
  revalidatePath("/");
  return { ok: true as const };
}

/**
 * Edit an organisation in place. Only the keys actually present in `patch` are
 * touched, so a caller that sends just a name can never blank the notes.
 * Renaming re-derives the slug, and both name and slug are checked against
 * every OTHER organisation so a rename can't collide its way into a 500.
 */
export async function updateOrganization(
  id: string,
  patch: { name?: string; notes?: string | null; website?: string | null; parentId?: string | null },
) {
  const data: {
    name?: string;
    slug?: string;
    notes?: string | null;
    website?: string | null;
    parentId?: string | null;
  } = {};

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) return { ok: false as const, error: "Name is required" };

    const slug = slugify(name);
    const clash = await prisma.organization.findFirst({
      where: { AND: [{ id: { not: id } }, { OR: [{ name }, { slug }] }] },
      select: { name: true },
    });
    if (clash) return { ok: false as const, error: `"${clash.name}" already exists` };

    data.name = name;
    data.slug = slug;
  }

  if (patch.website !== undefined) data.website = patch.website?.trim() || null;
  if (patch.notes !== undefined) data.notes = patch.notes?.trim() || null;

  if (patch.parentId !== undefined) {
    const parentId = patch.parentId || null;
    if (parentId === id) {
      return { ok: false as const, error: "An organisation cannot sit under itself" };
    }
    if (parentId) {
      // Walk up the proposed parent's ancestry. If we meet this organisation on
      // the way, the edit would close the chain into a loop and anything that
      // follows `parent` would spin forever.
      const seen = new Set<string>([id]);
      let cursor: string | null = parentId;
      while (cursor) {
        if (seen.has(cursor)) {
          return {
            ok: false as const,
            error:
              "That would make a loop — the organisation you picked already sits under this one",
          };
        }
        seen.add(cursor);
        const next: { parentId: string | null } | null = await prisma.organization.findUnique({
          where: { id: cursor },
          select: { parentId: true },
        });
        cursor = next?.parentId ?? null;
      }
    }
    data.parentId = parentId;
  }

  if (Object.keys(data).length === 0) return { ok: true as const };

  await prisma.organization.update({ where: { id }, data });
  revalidatePath("/organizations");
  revalidatePath("/");
  revalidatePath("/billing");
  return { ok: true as const };
}

/**
 * Organizations are only deletable once nothing points at them — silently
 * orphaning a project's client is worse than making Carl reassign it first.
 */
export async function deleteOrganization(id: string) {
  const inUse = await prisma.project.count({
    where: { OR: [{ clientId: id }, { endCustomerId: id }] },
  });
  if (inUse > 0) {
    return {
      ok: false as const,
      error: `Still assigned to ${inUse} project${inUse === 1 ? "" : "s"}`,
    };
  }

  await prisma.organization.delete({ where: { id } });
  revalidatePath("/organizations");
  return { ok: true as const };
}

export async function triggerSync() {
  const run = await prisma.syncRun.create({ data: { status: "RUNNING" } });

  try {
    const result = await runSync();
    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCESS",
        finishedAt: new Date(),
        projectsSeen: result.projectsSeen,
        projectsCreated: result.created,
        projectsUpdated: result.updated,
        log: result.log.join("\n"),
      },
    });
    revalidatePath("/");
    return { ok: true as const, ...result };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { status: "FAILED", finishedAt: new Date(), error },
    });
    return { ok: false as const, error };
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
